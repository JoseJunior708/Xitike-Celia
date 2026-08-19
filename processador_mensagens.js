import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import qrcode from 'qrcode-terminal';
import { createWorker } from 'tesseract.js';


const NUMEROS_AUTORIZADOS = (process.env.NUMEROS_AUTORIZADOS || '')
  .split(',')
  .map(n => normalizarNumero(n))
  .filter(Boolean);

if (NUMEROS_AUTORIZADOS.length === 0) {
  console.warn('AVISO: NUMEROS_AUTORIZADOS está vazio no .env — ninguém vai conseguir confirmar pagamentos ou criar xitiques.');
} else {
  console.log('Números autorizados (admin):', NUMEROS_AUTORIZADOS);
}

const NUMEROS_RECEBIMENTO_CELIA = (process.env.NUMEROS_RECEBIMENTO_CELIA || '')
  .split(',')
  .map(n => n.replace(/\D/g, ''))
  .filter(Boolean);

if (NUMEROS_RECEBIMENTO_CELIA.length === 0) {
  console.warn('AVISO: NUMEROS_RECEBIMENTO_CELIA está vazio no .env — checagem de destino errado/editado está DESLIGADA.');
}

// Normaliza um número moçambicano pra comparação: só dígitos, sem prefixo 258.
function normalizarNumero(numero) {
  if (!numero) return null;
  let digitos = numero.replace(/\D/g, '');
  if (digitos.length > 9 && digitos.startsWith('258')) {
    digitos = digitos.slice(3);
  }
  return digitos;
}

let dbPromise;
function getDb() {
  if (!dbPromise) {
    dbPromise = open({ filename: './xitike.db', driver: sqlite3.Database });
  }
  return dbPromise;
}

function extrairMPesaRecebido(texto) {
  const m = texto.match(
    /Confirmado\s+([A-Z0-9]{8,15})\.\s*Recebeste\s+(\d+(?:[.,]\d{1,2})?)\s*MT\s+de\s+(\d{6,12})-?\s*([^.]+?)\s+aos/is
  );
  if (!m) return null;
  return {
    tipo: 'recebido',
    id_transacao: m[1],
    valor: parseFloat(m[2].replace(',', '.')),
    remetente_numero: m[3],
    remetente_nome: m[4].trim()
  };
}

function extrairEMolaRecebido(texto) {
  const m = texto.match(
    /ID d[ae] tran[sç]?acao:?\s*([a-zA-Z0-9.]+)\.\s*Recebeste\s+(\d+(?:[.,]\d{1,2})?)\s*MT\s+de conta\s+(\d{6,12}),\s*nome:\s*([^.]+?)\s+as\s+/is
  );
  if (!m) return null;
  return {
    tipo: 'recebido',
    id_transacao: m[1],
    valor: parseFloat(m[2].replace(',', '.')),
    remetente_numero: m[3],
    remetente_nome: m[4].trim()
  };
}

// Cliente auto-reportando o próprio pagamento ("Transferiste ... para <destino>").
function extrairMPesaEnviado(texto) {
  const m = texto.match(
    /Confirmado\s+([A-Z0-9]{8,15})\.\s*Transferiste\s+(\d+(?:[.,]\d{1,2})?)\s*MT.*?para\s+(\d{6,12})/is
  );
  if (!m) return null;
  return { tipo: 'enviado', id_transacao: m[1], valor: parseFloat(m[2].replace(',', '.')), destino: m[3] };
}

function extrairEMolaEnviado(texto) {
  // Variante 1: "...para o MKHESH 835080105 atraves do SIMO ... montante: 120.00MT"
  let m = texto.match(
    /ID d[ae] tran[sç]?acao:?\s*([a-zA-Z0-9.]+)\..*?para o \w+\s+(\d{6,12}).*?montante:\s*(\d+(?:[.,]\d{1,2})?)\s*MT/is
  );
  if (m) return { tipo: 'enviado', id_transacao: m[1], destino: m[2], valor: parseFloat(m[3].replace(',', '.')) };

  // Variante 2: "Transferiste 255.00MT para conta 871210062, nome: ..."
  m = texto.match(
    /ID d[ae] tran[sç]?acao:?\s*([a-zA-Z0-9.]+)\.\s*Transferiste\s+(\d+(?:[.,]\d{1,2})?)\s*MT\s+para conta\s+(\d{6,12})/is
  );
  if (m) return { tipo: 'enviado', id_transacao: m[1], valor: parseFloat(m[2].replace(',', '.')), destino: m[3] };

  return null;
}

function extrairDadosConfirmacao(texto) {
  if (!texto) return null;
  return extrairMPesaRecebido(texto) || extrairEMolaRecebido(texto)
    || extrairMPesaEnviado(texto) || extrairEMolaEnviado(texto) || null;
}

// Remove acentos, baixa a caixa, tira pontuação — pra comparar nomes de forma tolerante.
function normalizarTexto(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function encontrarMembroPorNome(nomeNaSms, membros) {
  const tokensAlvo = normalizarTexto(nomeNaSms).split(/\s+/).filter(t => t.length >= 3);
  if (tokensAlvo.length === 0) return { membro: null, ambiguo: false };

  const candidatos = membros.filter(m => {
    const tokensMembro = normalizarTexto(m.nome).split(/\s+/).filter(t => t.length >= 3);
    return tokensMembro.some(t => tokensAlvo.includes(t));
  });

  if (candidatos.length === 1) return { membro: candidatos[0], ambiguo: false };
  return { membro: null, ambiguo: candidatos.length > 1 };
}


function aplicarPagamento(membro, valorPago, valorDiario) {
  const novoTotalPago = (membro.total_pago || 0) + valorPago;
  const diasPagos = Math.floor(novoTotalPago / valorDiario);
  const resto = novoTotalPago - diasPagos * valorDiario;
  return { novoTotalPago, diasPagos, resto };
}

// Monta a lista de todos os membros do grupo com o checklist de dias pagos,
// no formato "Nome ✅✅✅" 
async function gerarListaChecklist(db, idGrupo, valorDiario) {
  const membros = await db.all('SELECT nome, total_pago FROM membros WHERE id_grupo = ?', [idGrupo]);
  if (membros.length === 0) return '(nenhum membro registado ainda)';
  return membros
    .map(m => {
      const dias = Math.floor((m.total_pago || 0) / valorDiario);
      return `${m.nome} ${dias > 0 ? '✅'.repeat(dias) : '(sem pagamentos ainda)'}`;
    })
    .join('\n');
}

// Lê o texto de dentro de uma imagem (print de confirmação) via OCR.
// Cria o "worker" uma vez só e reaproveita — abrir um novo por mensagem seria lento.
let workerOcrPromise;
function obterWorkerOcr() {
  if (!workerOcrPromise) {
    workerOcrPromise = createWorker('por');
  }
  return workerOcrPromise;
}

function comTimeout(promessa, ms, mensagemErro) {
  return Promise.race([
    promessa,
    new Promise((_, reject) => setTimeout(() => reject(new Error(mensagemErro)), ms))
  ]);
}

async function extrairTextoDaImagem(msg) {
  try {
    const buffer = await comTimeout(downloadMediaMessage(msg, 'buffer', {}), 30000, 'download da imagem demorou demais');
    const worker = await obterWorkerOcr();
    const { data } = await comTimeout(worker.recognize(buffer), 30000, 'OCR demorou demais');
    return data.text?.trim() || null;
  } catch (erro) {
    console.error('Erro ao ler imagem por OCR:', erro.message || erro);
    return null;
  }
}

async function tratarMensagem(sock, db, msg) {
  if (!msg?.message || msg.key.fromMe) return;

  // Uma mensagem editada nunca é aceite como confirmação de pagamento — um
  // comprovativo colado de verdade não tem motivo pra ser editado depois.
  // Isto bloqueia de vez o caso de alguém trocar o número/nome numa mensagem
  // já enviada e tentar passar como se fosse nova.
  if (msg.message.editedMessage || msg.message.protocolMessage) {
    console.log('Mensagem editada/protocolo recebida — ignorada de propósito, nunca conta como confirmação.');
    return;
  }

  const idConversa = msg.key.remoteJid;
  const ehGrupo = idConversa?.endsWith('@g.us');
 
  let remetente = ehGrupo ? msg.key.participant : msg.key.remoteJid;
  if (remetente?.endsWith('@lid')) {
    remetente = (ehGrupo ? msg.key.participantAlt : msg.key.remoteJidAlt) || remetente;
  }
  if (!remetente) return;

  let texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();

  if (!texto && msg.message.imageMessage) {
    texto = (await extrairTextoDaImagem(msg)) || '';
    if (texto) console.log('Texto lido por OCR da imagem:', texto.slice(0, 200));
  }

  if (!texto) return;

  const ehAdmin = NUMEROS_AUTORIZADOS.includes(normalizarNumero(remetente));
  console.log(`Mensagem de ${remetente} (normalizado: ${normalizarNumero(remetente)}) — ehAdmin: ${ehAdmin}${msg.key.participant?.endsWith('@lid') ? ' [participant original era LID: ' + msg.key.participant + ']' : ''}`);

  // !novo. só admins podem criar um xitique novo, e só dentro de um grupo ---
  if (texto.startsWith('!novo')) {
    if (!ehAdmin) {
      await sock.sendMessage(idConversa, { text: 'Só um administrador pode criar um novo xitique.' });
      return;
    }
    if (!ehGrupo) {
      await sock.sendMessage(idConversa, { text: 'Este comando só funciona dentro de um grupo do WhatsApp — cria/abre o grupo primeiro, adiciona o bot, e digita !novo lá dentro.' });
      return;
    }
    const partes = texto.split(' ').filter(Boolean);
    const nome = partes[1];
    const valor = parseFloat(partes[2]);
    const dias = parseInt(partes[3], 10);

    if (!nome || Number.isNaN(valor) || Number.isNaN(dias)) {
      await sock.sendMessage(idConversa, {
        text: 'Uso correto: !novo NomeDoGrupo Valor DiasAteReceber\nEx: !novo Familia85 100 15'
      });
      return;
    }

    await db.run(
      `INSERT INTO grupos (id_grupo, nome_grupo, valor_diario, dias_ciclo) VALUES (?, ?, ?, ?)
       ON CONFLICT(id_grupo) DO UPDATE SET nome_grupo=excluded.nome_grupo, valor_diario=excluded.valor_diario, dias_ciclo=excluded.dias_ciclo`,
      [idConversa, nome, valor, dias]
    );
    await sock.sendMessage(idConversa, { text: `Xitique "${nome}" criado! ${valor}MT/dia, cada membro recebe a cada ${dias} dias.` });
    return;
  }

  if (texto === '!ajuda') {
    await sock.sendMessage(idConversa, {
      text:
        'Comandos do Xitike:\n' +
        '!novo Nome Valor DiasAteReceber — cria um xitique (admin)\n' +
        '!ordem 840000000 3 — define a posição desse membro na fila de recebimento (admin)\n' +
        '!fila — mostra a ordem de quem recebe o pote\n' +
        '!recebeu 840000000 — marca que esse membro recebeu o pote nesta rodada e avança a fila (admin)\n' +
        '!cadastrar 840000000 Nome Completo — regista um membro que ainda não escreveu no grupo (admin)\n' +
        '!pagos (seguido de uma linha "numero Nome valor" por membro) — importa em massa quem já pagou (admin)\n' +
        '!atribuir IDTransacao 845490083 — atribui manualmente um pagamento pendente a um membro (admin)\n' +
        '!banir 840000000— remove um membro do grupo manualmente (admin)\n' +
        '!bloqueados — lista quem foi sinalizado por reciclar comprovativo (admin)\n' +
        '!desbloquear 840000000 — tira alguém da lista de sinalizados (admin)\n' +
        '!pendentes — lista pagamentos que a Célia ainda precisa atribuir\n' +
        '!resumo — mostra a situação de cada membro\n' +
        'Cliente: cola aqui a tua SMS de confirmação de pagamento (M-Pesa/e-Mola).\n' +
        'Célia: cola aqui a SMS de "Recebeste" pra confirmar diretamente.'
    });
    return;
  }

  if (!ehGrupo) return;

  const grupo = await db.get('SELECT * FROM grupos WHERE id_grupo = ?', [idConversa]);
  if (!grupo) {
    console.log(`Grupo ${idConversa} ainda não está registado (sem !novo) — mensagem ignorada.`);
    return;
  }

  // --- !ordem — admin define a posição de um membro na fila de recebimento ---
  if (texto.startsWith('!ordem')) {
    if (!ehAdmin) return;
    const partes = texto.split(' ').filter(Boolean);
    const numeroAlvo = partes[1];
    const posicao = parseInt(partes[2], 10);
    if (!numeroAlvo || Number.isNaN(posicao)) {
      await sock.sendMessage(idConversa, { text: 'Uso correto: !ordem 84XXXXXXX 3' });
      return;
    }
    const jidAlvo = numeroAlvo.includes('@') ? numeroAlvo : `${numeroAlvo.replace(/\D/g, '')}@s.whatsapp.net`;
    const resultado = await db.run('UPDATE membros SET ordem = ? WHERE id_whatsapp = ? AND id_grupo = ?', [posicao, jidAlvo, idConversa]);
    if (resultado.changes === 0) {
      await sock.sendMessage(idConversa, { text: 'Não encontrei esse membro neste grupo. Ele já mandou alguma mensagem aqui?' });
    } else {
      await sock.sendMessage(idConversa, { text: `Posição ${posicao} atribuída.` });
    }
    return;
  }

  // --- !fila — mostra a ordem de recebimento definida pelo admin ---
  if (texto === '!fila') {
    const membros = await db.all(
      'SELECT nome, ordem, ultima_rodada_recebida FROM membros WHERE id_grupo = ? ORDER BY (ordem IS NULL), ordem ASC',
      [idConversa]
    );
    const linhas = membros.map((m, i) => {
      const jaRecebeu = m.ultima_rodada_recebida ? ' (já recebeu)' : '';
      return `${m.ordem ?? i + 1}. ${m.nome}${jaRecebeu}`;
    }).join('\n');
    await sock.sendMessage(idConversa, { text: `Fila de recebimento (rodada ${grupo.rodada_atual}):\n${linhas || 'Ninguém na fila ainda.'}` });
    return;
  }

  // --- !recebeu — admin confirma que alguém recebeu 
  if (texto.startsWith('!recebeu')) {
    if (!ehAdmin) return;
    const numeroAlvo = texto.split(' ').filter(Boolean)[1];
    if (!numeroAlvo) {
      await sock.sendMessage(idConversa, { text: 'Uso correto: !recebeu 845490083' });
      return;
    }
    const jidAlvo = numeroAlvo.includes('@') ? numeroAlvo : `${numeroAlvo.replace(/\D/g, '')}@s.whatsapp.net`;
    await db.run('UPDATE membros SET ultima_rodada_recebida = ? WHERE id_whatsapp = ? AND id_grupo = ?', [grupo.rodada_atual, jidAlvo, idConversa]);
    await db.run('UPDATE grupos SET rodada_atual = rodada_atual + 1 WHERE id_grupo = ?', [idConversa]);
    await sock.sendMessage(idConversa, { text: `Registado. Xitike segue pra rodada ${grupo.rodada_atual + 1}.` });
    return;
  }

  const nomeContato = msg.pushName || remetente.split('@')[0];
  await db.run(
    `INSERT INTO membros (id_whatsapp, id_grupo, nome) VALUES (?, ?, ?)
     ON CONFLICT(id_whatsapp, id_grupo) DO NOTHING`,
    [remetente, idConversa, nomeContato]
  );

  //  !pendentes — lista pagamentos que não bateram com ninguém automaticamente 
  // !banir — admin remove um membro manualmente 
  if (texto.startsWith('!banir')) {
    if (!ehAdmin) return;
    const numeroAlvo = texto.split(' ').filter(Boolean)[1];
    if (!numeroAlvo) {
      await sock.sendMessage(idConversa, { text: 'Uso correto: !banir 84XXXXXXX' });
      return;
    }
    const jidAlvo = numeroAlvo.includes('@') ? numeroAlvo : `${numeroAlvo.replace(/\D/g, '')}@s.whatsapp.net`;
    try {
      await sock.groupParticipantsUpdate(idConversa, [jidAlvo], 'remove');
      await sock.sendMessage(idConversa, { text: `${numeroAlvo} removido do grupo.` });
    } catch (erro) {
      console.error('Não consegui remover:', erro);
      await sock.sendMessage(idConversa, { text: 'Não consegui remover — o Xitike precisa de ser admin do grupo.' });
    }
    return;
  }

  // --- !bloqueados — lista quem foi sinalizado por reciclar comprovativo ---
  if (texto === '!bloqueados') {
    if (!ehAdmin) return;
    const bloqueados = await db.all('SELECT * FROM membros_bloqueados WHERE id_grupo = ?', [idConversa]);
    if (bloqueados.length === 0) {
      await sock.sendMessage(idConversa, { text: 'Nenhum membro sinalizado.' });
      return;
    }
    const linhas = bloqueados.map(b => `${b.nome} — ${b.motivo}`).join('\n');
    await sock.sendMessage(idConversa, { text: `Sinalizados:\n${linhas}\n\nUsa !desbloquear 84XXXXXXX pra limpar depois de reveres.` });
    return;
  }

  //!desbloquear — tira alguém da lista de sinalizados, depois da Célia rever
  if (texto.startsWith('!desbloquear')) {
    if (!ehAdmin) return;
    const numeroAlvo = texto.split(' ').filter(Boolean)[1];
    if (!numeroAlvo) {
      await sock.sendMessage(idConversa, { text: 'Uso correto: !desbloquear 84XXXXXXX' });
      return;
    }
    const jidAlvo = numeroAlvo.includes('@') ? numeroAlvo : `${numeroAlvo.replace(/\D/g, '')}@s.whatsapp.net`;
    await db.run('DELETE FROM membros_bloqueados WHERE id_whatsapp = ? AND id_grupo = ?', [jidAlvo, idConversa]);
    await sock.sendMessage(idConversa, { text: `${numeroAlvo} removido da lista de sinalizados.` });
    return;
  }

  //  !cadastrar — admin regista um membro que ainda não escreveu no grupo 
  if (texto.startsWith('!cadastrar')) {
    if (!ehAdmin) return;
    const partes = texto.split(' ').filter(Boolean);
    const numeroAlvo = partes[1];
    const nomeAlvo = partes.slice(2).join(' ');
    if (!numeroAlvo || !nomeAlvo) {
      await sock.sendMessage(idConversa, { text: 'Uso correto: !cadastrar 84XXXXXXX Nome Completo' });
      return;
    }
    const jidAlvo = `${numeroAlvo.replace(/\D/g, '')}@s.whatsapp.net`;
    await db.run(
      `INSERT INTO membros (id_whatsapp, id_grupo, nome) VALUES (?, ?, ?)
       ON CONFLICT(id_whatsapp, id_grupo) DO UPDATE SET nome=excluded.nome`,
      [jidAlvo, idConversa, nomeAlvo]
    );
    await sock.sendMessage(idConversa, { text: `${nomeAlvo} registado.` });
    return;
  }

  if (texto.startsWith('!pagos')) {
    if (!ehAdmin) return;
    const linhas = texto.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    if (linhas.length === 0) {
      await sock.sendMessage(idConversa, {
        text: 'Uso correto (uma linha por membro):\n!pagos\n84XXXXXXX Nome Completo 100\n84YYYYYYY Outro Nome 100'
      });
      return;
    }
    let processados = 0;
    const comErro = [];
    for (const linha of linhas) {
      const partesLinha = linha.split(' ').filter(Boolean);
      const numeroLinha = partesLinha[0];
      const valorLinha = parseFloat(partesLinha[partesLinha.length - 1]);
      const nomeLinha = partesLinha.slice(1, -1).join(' ');
      if (!numeroLinha || !nomeLinha || Number.isNaN(valorLinha)) {
        comErro.push(linha);
        continue;
      }
      const jidLinha = `${numeroLinha.replace(/\D/g, '')}@s.whatsapp.net`;
      await db.run(
        `INSERT INTO membros (id_whatsapp, id_grupo, nome) VALUES (?, ?, ?)
         ON CONFLICT(id_whatsapp, id_grupo) DO UPDATE SET nome=excluded.nome`,
        [jidLinha, idConversa, nomeLinha]
      );
      const membroLinha = await db.get('SELECT * FROM membros WHERE id_whatsapp = ? AND id_grupo = ?', [jidLinha, idConversa]);
      const { novoTotalPago } = aplicarPagamento(membroLinha, valorLinha, grupo.valor_diario);
      await db.run(
        `UPDATE membros SET total_pago = ? WHERE id_whatsapp = ? AND id_grupo = ?`,
        [novoTotalPago, jidLinha, idConversa]
      );
      processados++;
    }
    let resposta = `${processados} membro(s) importado(s).`;
    if (comErro.length > 0) resposta += `\nNão consegui ler estas linhas:\n${comErro.join('\n')}`;
    await sock.sendMessage(idConversa, { text: resposta });
    return;
  }

  if (texto === '!pendentes') {
    if (!ehAdmin) return;
    const pendentes = await db.all('SELECT * FROM pagamentos_pendentes WHERE id_grupo = ?', [idConversa]);
    const aguardandoSms = await db.all('SELECT * FROM reivindicacoes_pendentes WHERE id_grupo = ?', [idConversa]);

    if (pendentes.length === 0 && aguardandoSms.length === 0) {
      await sock.sendMessage(idConversa, { text: 'Nenhum pagamento pendente.' });
      return;
    }

    let resposta = '';
    if (aguardandoSms.length > 0) {
      const linhasSms = aguardandoSms.map(p => `${p.id_transacao} — ${p.valor}MT de "${p.nome_contato}" (à espera da SMS real chegar)`).join('\n');
      resposta += `Aguardando confirmação por SMS:\n${linhasSms}\n\n`;
    }
    if (pendentes.length > 0) {
      const linhas = pendentes.map(p => `${p.id_transacao} — ${p.valor}MT de "${p.remetente_nome}"`).join('\n');
      resposta += `Precisam de atribuição manual (!atribuir IDTransacao 84XXXXXXX):\n${linhas}`;
    }
    await sock.sendMessage(idConversa, { text: resposta.trim() });
    return;
  }

  // --- !atribuir — admin liga manualmente um pagamento pendente a um membro ---
  if (texto.startsWith('!atribuir')) {
    if (!ehAdmin) return;
    const partes = texto.split(' ').filter(Boolean);
    const idTransacao = partes[1];
    const numeroAlvo = partes[2];
    if (!idTransacao || !numeroAlvo) {
      await sock.sendMessage(idConversa, { text: 'Uso correto: !atribuir IDTransacao 84XXXXXXX' });
      return;
    }
    const pendente = await db.get('SELECT * FROM pagamentos_pendentes WHERE id_transacao = ? AND id_grupo = ?', [idTransacao, idConversa]);
    if (!pendente) {
      await sock.sendMessage(idConversa, { text: 'Não encontrei esse ID nos pagamentos pendentes.' });
      return;
    }
    const jidAlvo = numeroAlvo.includes('@') ? numeroAlvo : `${numeroAlvo.replace(/\D/g, '')}@s.whatsapp.net`;
    await db.run(
      `INSERT INTO membros (id_whatsapp, id_grupo, nome) VALUES (?, ?, ?)
       ON CONFLICT(id_whatsapp, id_grupo) DO NOTHING`,
      [jidAlvo, idConversa, numeroAlvo]
    );
    const membroAlvo = await db.get('SELECT * FROM membros WHERE id_whatsapp = ? AND id_grupo = ?', [jidAlvo, idConversa]);
    const { novoTotalPago } = aplicarPagamento(membroAlvo, pendente.valor, grupo.valor_diario);
    await db.run(
      `UPDATE membros SET total_pago = ?, ultimo_pagamento = date('now') WHERE id_whatsapp = ? AND id_grupo = ?`,
      [novoTotalPago, jidAlvo, idConversa]
    );
    await db.run('DELETE FROM pagamentos_pendentes WHERE id_transacao = ?', [idTransacao]);
    await sock.sendMessage(idConversa, { text: `Pagamento de ${pendente.valor}MT atribuído a ${membroAlvo.nome}.\n\n${await gerarListaChecklist(db, idConversa, grupo.valor_diario)}` });
    return;
  }

  if (texto === '!resumo') {
    const lista = await gerarListaChecklist(db, idConversa, grupo.valor_diario);
    await sock.sendMessage(idConversa, { text: `Situação do xitique "${grupo.nome_grupo}":\n${lista}` });
    return;
  }

  // --- Tenta interpretar como confirmação de pagamento ---
  const confirmacao = extrairDadosConfirmacao(texto);
  if (!confirmacao) {
    if (/\bMT\b|confirmad[oa]|transferist[e]s?|recebest[e]s?/i.test(texto)) {
      console.log('Mensagem parece confirmação mas não bateu com nenhum formato conhecido:\n---\n' + texto + '\n---');
      await db.run(
        `INSERT INTO mensagens_nao_reconhecidas (id_grupo, remetente, nome_contato, texto) VALUES (?, ?, ?, ?)`,
        [idConversa, remetente, nomeContato, texto]
      );
      await sock.sendMessage(idConversa, {
        text: `${nomeContato}, Recebi a tua mensagem mas não consegui reconhecer o formato do comprovativo. Confirma manualmente com a Célia por agora! Este caso vai ser reportado pra corrigirmos o reconhecimento automático.`
      });
    }
    return;
  }

  const jaRegistado = await db.get('SELECT 1 FROM sms_recebidos WHERE id_transacao = ?', [confirmacao.id_transacao]);
  if (jaRegistado) {
    if (confirmacao.tipo === 'enviado') {
      const membroSuspeito = await db.get('SELECT * FROM membros WHERE id_whatsapp = ? AND id_grupo = ?', [remetente, idConversa]);
      const jaRecebeuOPote = membroSuspeito?.ultima_rodada_recebida != null;

      if (jaRecebeuOPote) {
        // Já recebeu o xitike remover estragaria e seria precipitado.
        // Fica sinalizado pra o Admin decidir com calma.
        await db.run(
          `INSERT INTO membros_bloqueados (id_whatsapp, id_grupo, nome, motivo) VALUES (?, ?, ?, ?)
           ON CONFLICT(id_whatsapp, id_grupo) DO UPDATE SET motivo=excluded.motivo, criado_em=CURRENT_TIMESTAMP`,
          [remetente, idConversa, nomeContato, `Reciclou o comprovativo ${confirmacao.id_transacao} (já tinha recebido o pote)`]
        );
        await sock.sendMessage(idConversa, { text: `${nomeContato}, este comprovativo (${confirmacao.id_transacao}) já foi usado antes. Como já recebeste o pote desta rodada, não vais ser removido automaticamente — isto foi sinalizado pra Célia rever.` });
      } else {
        await sock.sendMessage(idConversa, { text: `${nomeContato}, este comprovativo (${confirmacao.id_transacao}) já foi usado antes. Vais ser removido do grupo.` });
        try {
          await sock.groupParticipantsUpdate(idConversa, [remetente], 'remove');
        } catch (erroRemocao) {
          console.error('Não consegui remover o membro (o bot é admin do grupo?):', erroRemocao);
          await sock.sendMessage(idConversa, { text: `Não consegui remover ${nomeContato} automaticamente — o Xitike precisa de ser admin do grupo pra isso.` });
        }
      }
    } else {
      await sock.sendMessage(idConversa, { text: `Este comprovativo (${confirmacao.id_transacao}) já tinha sido registado antes. Não contado em duplicado.` });
    }
    return;
  }
  await db.run(
    `INSERT INTO sms_recebidos (id_transacao, id_grupo, remetente, valor, mensagem_bruta) VALUES (?, ?, ?, ?, ?)`,
    [confirmacao.id_transacao, idConversa, remetente, confirmacao.valor, texto]
  );

  // --- "Recebeste" postado por um MEMBRO comum 
  // Interpretamos isto como prova de ter recebido
 //só conta se o dinheiro veio de um número conhecido do Admin.
  if (confirmacao.tipo === 'recebido' && !ehAdmin) {
    const numeroOrigemNormalizado = normalizarNumero(confirmacao.remetente_numero);
    const veioDaCelia = NUMEROS_RECEBIMENTO_CELIA.length > 0 && NUMEROS_RECEBIMENTO_CELIA.includes(numeroOrigemNormalizado);

    if (!veioDaCelia) {
      await sock.sendMessage(idConversa, {
        text: `Aviso: número errado. ${nomeContato} postou um comprovativo de recebimento, mas não veio de um número conhecido da Célia. Números corretos: ${NUMEROS_RECEBIMENTO_CELIA.join(', ') || '(nenhum configurado)'}. Não marcado automaticamente como pote recebido — a Célia confirma manualmente com !recebeu.`
      });
      return;
    }

    await db.run('UPDATE membros SET ultima_rodada_recebida = ? WHERE id_whatsapp = ? AND id_grupo = ?', [grupo.rodada_atual, remetente, idConversa]);
    await db.run('UPDATE grupos SET rodada_atual = rodada_atual + 1 WHERE id_grupo = ?', [idConversa]);
    await sock.sendMessage(idConversa, { text: `Confirmado: ${nomeContato} recebeu o pote desta rodada. Xitike segue pra rodada ${grupo.rodada_atual + 1}.` });
    return;
  }

  // --- Cliente auto-reportando ("Transferiste ... para <destino>") ---
  if (confirmacao.tipo === 'enviado') {
    const webhookAtivo = !!process.env.WEBHOOK_TOKEN;

    if (webhookAtivo) {
      // Modo seguro: só valida se a mesma transação já tiver chegado como
      // SMS no celular do Admin (via Atalho). Sem isso, fica à espera.
      const smsReal = await db.get('SELECT * FROM sms_celia WHERE id_transacao = ? AND usado = 0', [confirmacao.id_transacao]);

      if (!smsReal) {
        await db.run(
          `INSERT INTO reivindicacoes_pendentes (id_transacao, id_grupo, remetente, valor, nome_contato) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id_transacao) DO NOTHING`,
          [confirmacao.id_transacao, idConversa, remetente, confirmacao.valor, nomeContato]
        );
        await sock.sendMessage(idConversa, {
          text: `Recebi a tua confirmação, ${nomeContato}. A aguardar a SMS real chegar à Célia pra validar — assim que chegar, credito automaticamente.`
        });
        return;
      }

      if (Math.abs(smsReal.valor - confirmacao.valor) > 0.01) {
        await sock.sendMessage(idConversa, {
          text: `Aviso: ${nomeContato}, o valor que mandaste (${confirmacao.valor}MT) não bate com o valor da SMS real recebida pela Célia pra essa transação. Confirma com ela antes de contar como pago.`
        });
        return;
      }

      await db.run('UPDATE sms_celia SET usado = 1 WHERE id_transacao = ?', [confirmacao.id_transacao]);
    } else if (NUMEROS_RECEBIMENTO_CELIA.length > 0) {
      // Sem webhook configurado: cai de volta pra checagem de destino (mais fraca).
      const destinoNormalizado = normalizarNumero(confirmacao.destino);
      if (!NUMEROS_RECEBIMENTO_CELIA.includes(destinoNormalizado)) {
        await sock.sendMessage(idConversa, {
          text: `Aviso: número errado. ${nomeContato}, o comprovativo que mandaste mostra um destino diferente do número oficial da Célia. Números corretos: ${NUMEROS_RECEBIMENTO_CELIA.join(', ')}. Pode ter sido engano — confirma com ela antes de contar como pago. (Pagamento NÃO registado automaticamente.)`
        });
        return;
      }
    }

    const membroPagador = await db.get('SELECT * FROM membros WHERE id_whatsapp = ? AND id_grupo = ?', [remetente, idConversa]);
    const { novoTotalPago } = aplicarPagamento(membroPagador, confirmacao.valor, grupo.valor_diario);
    await db.run(
      `UPDATE membros SET total_pago = ?, ultimo_pagamento = date('now') WHERE id_whatsapp = ? AND id_grupo = ?`,
      [novoTotalPago, remetente, idConversa]
    );
    const lista = await gerarListaChecklist(db, idConversa, grupo.valor_diario);
    await sock.sendMessage(idConversa, { text: `Pagamento de ${confirmacao.valor}MT confirmado para ${nomeContato}.\n\n${lista}` });
    return;
  }

  // --- Célia reportando o que recebeu ("Recebeste ... de <remetente>") ---
  const membrosDoGrupo = await db.all('SELECT * FROM membros WHERE id_grupo = ?', [idConversa]);
  const { membro, ambiguo } = encontrarMembroPorNome(confirmacao.remetente_nome, membrosDoGrupo);

  if (!membro) {
    await db.run(
      `INSERT INTO pagamentos_pendentes (id_transacao, id_grupo, valor, remetente_numero, remetente_nome, mensagem_bruta) VALUES (?, ?, ?, ?, ?, ?)`,
      [confirmacao.id_transacao, idConversa, confirmacao.valor, confirmacao.remetente_numero, confirmacao.remetente_nome, texto]
    );
    const motivo = ambiguo ? 'o nome bateu com mais de um membro' : 'não encontrei esse nome em nenhum membro';
    await sock.sendMessage(idConversa, {
      text: `Recebi ${confirmacao.valor}MT de "${confirmacao.remetente_nome}", mas ${motivo}. Usa !atribuir ${confirmacao.id_transacao} 84XXXXXXX pra ligar ao membro certo.`
    });
    return;
  }

  const { novoTotalPago } = aplicarPagamento(membro, confirmacao.valor, grupo.valor_diario);
  await db.run(
    `UPDATE membros SET total_pago = ?, ultimo_pagamento = date('now') WHERE id_whatsapp = ? AND id_grupo = ?`,
    [novoTotalPago, membro.id_whatsapp, idConversa]
  );

  const lista = await gerarListaChecklist(db, idConversa, grupo.valor_diario);
  await sock.sendMessage(idConversa, { text: `Pagamento de ${confirmacao.valor}MT registado para ${membro.nome}.\n\n${lista}` });
}

let sockAtual = null;

export async function iniciarWhatsApp() {
  const db = await getDb();

  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    console.log('Usando versão do protocolo WhatsApp:', version.join('.'));
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false });
    sockAtual = sock;

    const numeroBot = (process.env.NUMERO_BOT || '').replace(/\D/g, '');
    if (!state.creds.registered && numeroBot) {
      setTimeout(async () => {
        try {
          const codigoPareamento = await sock.requestPairingCode(numeroBot);
          console.log('\n================================');
          console.log('CÓDIGO DE PAREAMENTO:', codigoPareamento);
          console.log('No WhatsApp do número', numeroBot, ':');
          console.log('Aparelhos ligados > Ligar aparelho > Ligar com número de telefone');
          console.log('================================\n');
        } catch (erro) {
          console.error('Erro ao pedir código de pareamento:', erro);
        }
      }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !numeroBot) {
        console.log('\nEscaneia este QR code com o WhatsApp (Aparelhos ligados > Ligar aparelho):\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const deveReconectar = codigo !== DisconnectReason.loggedOut;
        console.log('Conexão do WhatsApp fechada. Reconectar:', deveReconectar);
        if (deveReconectar) conectar();
      } else if (connection === 'open') {
        console.log('Xitike conectado ao WhatsApp.');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        await tratarMensagem(sock, db, messages[0]);
      } catch (erro) {
        console.error('Erro ao processar mensagem:', erro);
      }
    });
  }

  await conectar();
}

/**
 * Processa uma SMS de "Recebeste" vinda diretamente do telemóvel da Célia
 * (via Atalhos do iPhone → webhook). Isto NUNCA escolhe o grupo/membro
 * sozinho por nome — quem diz o grupo certo é sempre o cliente, ao colar a
 * confirmação lá dentro (uma pessoa pode estar em vários xitiques ao mesmo
 * tempo, então adivinhar pelo nome não é seguro).
 *
 * Em vez disso, esta função só guarda a SMS real e cruza pelo ID da
 * transação: se um cliente já tinha colado a confirmação num grupo e
 * estava à espera, completa o pagamento agora. Se ainda não postou, fica
 * guardada à espera de alguém colar.
 */
export async function processarSmsExterna(texto) {
  const db = await getDb();

  const confirmacao = extrairDadosConfirmacao(texto);
  if (!confirmacao) return { ok: false, motivo: 'formato não reconhecido' };

  if (confirmacao.tipo !== 'recebido') {
    return { ok: false, motivo: 'formato reconhecido, mas não é uma SMS de recebimento' };
  }

  const jaExiste = await db.get('SELECT 1 FROM sms_celia WHERE id_transacao = ?', [confirmacao.id_transacao]);
  if (jaExiste) return { ok: false, motivo: 'duplicado — esta SMS já tinha chegado antes' };

  await db.run(
    `INSERT INTO sms_celia (id_transacao, valor, remetente_nome, remetente_numero) VALUES (?, ?, ?, ?)`,
    [confirmacao.id_transacao, confirmacao.valor, confirmacao.remetente_nome, confirmacao.remetente_numero]
  );

  // Alguém já postou a confirmação correspondente num grupo e está à espera?
  const reivindicacao = await db.get('SELECT * FROM reivindicacoes_pendentes WHERE id_transacao = ?', [confirmacao.id_transacao]);
  if (!reivindicacao) {
    return { ok: true, status: 'guardado', motivo: 'nenhum cliente postou esta confirmação ainda' };
  }

  if (Math.abs(reivindicacao.valor - confirmacao.valor) > 0.01) {
    return { ok: true, status: 'valor_nao_bate', motivo: `cliente postou ${reivindicacao.valor}MT mas a SMS real é de ${confirmacao.valor}MT` };
  }

  const grupo = await db.get('SELECT * FROM grupos WHERE id_grupo = ?', [reivindicacao.id_grupo]);
  const membro = await db.get('SELECT * FROM membros WHERE id_whatsapp = ? AND id_grupo = ?', [reivindicacao.remetente, reivindicacao.id_grupo]);
  if (!grupo || !membro) {
    return { ok: false, motivo: 'grupo ou membro da reivindicação pendente já não existe' };
  }

  const { novoTotalPago } = aplicarPagamento(membro, confirmacao.valor, grupo.valor_diario);
  await db.run(
    `UPDATE membros SET total_pago = ?, ultimo_pagamento = date('now') WHERE id_whatsapp = ? AND id_grupo = ?`,
    [novoTotalPago, membro.id_whatsapp, grupo.id_grupo]
  );
  await db.run('UPDATE sms_celia SET usado = 1 WHERE id_transacao = ?', [confirmacao.id_transacao]);
  await db.run('DELETE FROM reivindicacoes_pendentes WHERE id_transacao = ?', [confirmacao.id_transacao]);

  const lista = await gerarListaChecklist(db, grupo.id_grupo, grupo.valor_diario);
  if (sockAtual) {
    await sockAtual.sendMessage(grupo.id_grupo, {
      text: `Pagamento de ${confirmacao.valor}MT confirmado para ${membro.nome} (SMS real validada).\n\n${lista}`
    });
  }

  return { ok: true, status: 'confirmado', grupo: grupo.nome_grupo, membro: membro.nome };
}
