import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import os from 'os';
import fs from 'fs';
import multer from 'multer';
import { iniciarWhatsApp, processarSmsExterna } from './processador_mensagens.js';

fs.mkdirSync('public/tmp', { recursive: true });
const upload = multer({
  dest: 'public/tmp/',
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype))
});

const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!SESSION_SECRET || !ADMIN_PASSWORD) {
  console.error(
    'Faltam variáveis de ambiente. Cria um ficheiro .env com SESSION_SECRET e ADMIN_PASSWORD.'
  );
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8 // 8 horas
  }
}));
app.set('view engine', 'ejs');
app.use(express.static('public'));

const db = await open({ filename: './xitike.db', driver: sqlite3.Database });

// limite pra tentativas de login (
const tentativasLogin = new Map();
const LIMITE_TENTATIVAS = 5;
const JANELA_MS = 15 * 60 * 1000; // 15 min

function verificarLogin(req, res, next) {
  if (req.session.autenticado) return next();
  res.render('login', { erro: null });
}

app.get('/login', (req, res) => res.render('login', { erro: null }));

app.post('/login', async (req, res) => {
  const ip = req.ip;
  const agora = Date.now();
  const registo = tentativasLogin.get(ip) || { count: 0, desde: agora };

  if (agora - registo.desde > JANELA_MS) {
    registo.count = 0;
    registo.desde = agora;
  }

  if (registo.count >= LIMITE_TENTATIVAS) {
    return res.status(429).render('login', { erro: 'Muitas tentativas. Espera uns minutos e tenta de novo.' });
  }

  const senhaCorreta = (req.body.senha || '') === ADMIN_PASSWORD;

  if (senhaCorreta) {
    tentativasLogin.delete(ip);
    req.session.autenticado = true;
    res.redirect('/admin');
  } else {
    registo.count += 1;
    tentativasLogin.set(ip, registo);
    res.render('login', { erro: 'Palavra-passe incorreta. Tenta novamente.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Painel de administração 
app.get('/admin', verificarLogin, async (req, res) => {
  try {
    const grupos = await db.all('SELECT * FROM grupos');
    const membros = await db.all('SELECT * FROM membros');
    const numerosRecebimentoCelia = (process.env.NUMEROS_RECEBIMENTO_CELIA || '').split(',').map(n => n.trim()).filter(Boolean);

    const painelGrupos = grupos.map(grupo => {
      const membrosDoGrupo = membros
        .filter(m => m.id_grupo === grupo.id_grupo)
        .map(m => ({ ...m, diasPagos: Math.floor((m.total_pago || 0) / grupo.valor_diario) }))
        .sort((a, b) => (a.ordem ?? 999) - (b.ordem ?? 999));

      const totalFaturado = membrosDoGrupo.reduce((acc, m) => acc + (m.total_pago || 0), 0);
      const dias = grupo.dias_ciclo || 30;
      const metaTotal = grupo.valor_diario * membrosDoGrupo.length * dias;

      return {
        ...grupo,
        membros: membrosDoGrupo,
        membrosAtivos: membrosDoGrupo.length,
        totalFaturado,
        metaTotal
      };
    });

    res.render('painel', { painelGrupos, botOnline: true, numerosRecebimentoCelia });
  } catch (error) {
    console.error('ERRO NO PAINEL:', error);
    res.status(500).send('Erro ao processar o painel.');
  }
});

app.get('/admin/pagamentos', verificarLogin, async (req, res) => {
  try {
    const grupos = await db.all('SELECT id_grupo, nome_grupo FROM grupos');
    const nomeGrupo = Object.fromEntries(grupos.map(g => [g.id_grupo, g.nome_grupo]));

    const historico = (await db.all('SELECT * FROM sms_recebidos ORDER BY data_recebimento DESC LIMIT 100'))
      .map(h => ({ ...h, nome_grupo: nomeGrupo[h.id_grupo] || '—' }));

    const aguardandoCliente = await db.all('SELECT * FROM sms_celia WHERE usado = 0 ORDER BY criado_em DESC');

    const aguardandoSms = (await db.all('SELECT * FROM reivindicacoes_pendentes ORDER BY criado_em DESC'))
      .map(r => ({ ...r, nome_grupo: nomeGrupo[r.id_grupo] || '—' }));

    const aguardandoAtribuicao = (await db.all('SELECT * FROM pagamentos_pendentes ORDER BY data_recebimento DESC'))
      .map(p => ({ ...p, nome_grupo: nomeGrupo[p.id_grupo] || '—' }));

    res.render('pagamentos', { historico, aguardandoCliente, aguardandoSms, aguardandoAtribuicao });
  } catch (error) {
    console.error('ERRO NA TELA DE PAGAMENTOS:', error);
    res.status(500).send('Erro ao processar a tela de pagamentos.');
  }
});

function obterIpLocal() {
  const redes = os.networkInterfaces();
  const candidatos = [];
  for (const nome of Object.keys(redes)) {
    for (const rede of redes[nome]) {
      if (rede.family === 'IPv4' && !rede.internal) {
        candidatos.push({ nome, endereco: rede.address });
      }
    }
  }
  // Prefere adaptadores de WiFi/Ethernet reais; ignora os virtuais (VirtualBox, VMware, Hyper-V etc).
  const virtual = /virtualbox|vmware|hyper-v|vethernet|loopback|docker/i;
  const preferido = candidatos.find(c => !virtual.test(c.nome));
  return (preferido || candidatos[0])?.endereco || null;
}

app.get('/logo', (req, res) => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (fs.existsSync('public/logo' + ext)) return res.sendFile(process.cwd() + '/public/logo' + ext);
  }
  res.status(404).end();
});

app.post('/admin/logo', verificarLogin, upload.single('logo'), (req, res) => {
  if (req.file) {
    const destino = 'public/logo' + req.file.originalname.slice(req.file.originalname.lastIndexOf('.'));
    // Remove logo antiga (pode ter extensão diferente da nova)
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      try { fs.unlinkSync('public/logo' + ext); } catch { /* não existia, tudo bem */ }
    }
    fs.renameSync(req.file.path, destino);
  }
  res.redirect('/admin');
});


// O Atalho manda POST aqui sempre que chega uma SMS de M-Pesa/e-Mola.
// Protegido por um token simples no cabeçalho Authorization.
app.post('/api/gateway/sms', express.json(), async (req, res) => {
  console.log('--- Webhook /api/gateway/sms recebeu uma chamada ---');
  const tokenEsperado = process.env.WEBHOOK_TOKEN;
  const autorizacao = req.headers.authorization || '';

  if (!tokenEsperado) {
    console.warn('AVISO: WEBHOOK_TOKEN não configurado no .env — o endpoint /api/gateway/sms está DESLIGADO.');
    return res.status(503).json({ erro: 'webhook não configurado' });
  }
  if (autorizacao !== `xitike ${tokenEsperado}`) {
    console.warn('Token recebido não bate com o esperado. Recebido:', autorizacao);
    return res.status(401).json({ erro: 'token inválido' });
  }

  const texto = (req.body?.texto_sms || '').trim();
  if (!texto) {
    console.warn('texto_sms veio vazio. Corpo recebido:', req.body);
    return res.status(400).json({ erro: 'texto_sms em falta' });
  }
  console.log('texto_sms recebido:', texto);

  try {
    const resultado = await processarSmsExterna(texto);
    console.log('Resultado do processamento:', resultado);
    res.json(resultado);
  } catch (erro) {
    console.error('Erro ao processar SMS externa:', erro);
    res.status(500).json({ erro: 'erro interno' });
  }
});

iniciarWhatsApp();
app.listen(3000, '0.0.0.0', () => {
  console.log('Servidor Xitike rodando em http://localhost:3000/admin');
  const ipLocal = obterIpLocal();
  if (ipLocal) {
    console.log(`No telemóvel (mesmo WiFi): http://${ipLocal}:3000/admin`);
  }
});