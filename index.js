import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
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
app.set('trust proxy', 1); 

//  segurança 
app.use(helmet({ contentSecurityPolicy: false }));


app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8 // 8 horas
  }
}));
app.set('view engine', 'ejs');
app.use(express.static('public'));

const db = await open({ filename: './xitike.db', driver: sqlite3.Database });

//  limite pra tentativas de login 
const tentativasLogin = new Map();
const LIMITE_TENTATIVAS = 5;
const JANELA_MS = 15 * 60 * 1000; // 15 min

function verificarLogin(req, res, next) {
  if (req.session.autenticado) return next();
  res.render('login', { erro: null });
}

app.get('/login', (req, res) => res.render('login', { erro: null }));

app.post('/login', async (req, res) => {

  if (req.body.website) {
    return res.render('login', { erro: 'Palavra-passe incorreta. Tenta novamente.' });
  }

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

// --- Painel de administração ---
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

    const naoReconhecidas = (await db.all('SELECT * FROM mensagens_nao_reconhecidas ORDER BY criado_em DESC LIMIT 50'))
      .map(m => ({ ...m, nome_grupo: nomeGrupo[m.id_grupo] || '—' }));

    res.render('pagamentos', { historico, aguardandoCliente, aguardandoSms, aguardandoAtribuicao, naoReconhecidas });
  } catch (error) {
    console.error('ERRO NA TELA DE PAGAMENTOS:', error);
    res.status(500).send('Erro ao processar a tela de pagamentos.');
  }
});

app.get('/admin/bloqueados', verificarLogin, async (req, res) => {
  try {
    const grupos = await db.all('SELECT id_grupo, nome_grupo FROM grupos');
    const nomeGrupo = Object.fromEntries(grupos.map(g => [g.id_grupo, g.nome_grupo]));
    const bloqueados = (await db.all('SELECT * FROM membros_bloqueados ORDER BY criado_em DESC'))
      .map(b => ({ ...b, nome_grupo: nomeGrupo[b.id_grupo] || '—' }));
    res.render('bloqueados', { bloqueados });
  } catch (error) {
    console.error('ERRO NA TELA DE BLOQUEADOS:', error);
    res.status(500).send('Erro ao processar a tela de bloqueados.');
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

const EXTENSAO_POR_MIMETYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

app.post('/admin/logo', verificarLogin, upload.single('logo'), (req, res) => {
  if (req.file) {
    const extensao = EXTENSAO_POR_MIMETYPE[req.file.mimetype];
    if (!extensao) {
      fs.unlinkSync(req.file.path);
      return res.status(400).send('Tipo de ficheiro não suportado.');
    }
    // Remove logo antiga (pode ter extensão diferente da nova)
    for (const ext of Object.values(EXTENSAO_POR_MIMETYPE)) {
      try { fs.unlinkSync('public/logo' + ext); } catch { /* não existia, tudo bem */ }
    }
    fs.renameSync(req.file.path, 'public/logo' + extensao);
  }
  res.redirect('/admin');
});


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
const porta = process.env.PORT || 3000;
app.listen(porta, '0.0.0.0', () => {
  console.log(`Servidor Xitike rodando na porta ${porta}`);
  const ipLocal = obterIpLocal();
  if (ipLocal) {
    console.log(`No telemóvel (mesmo WiFi): http://${ipLocal}:${porta}/admin`);
  }
});
