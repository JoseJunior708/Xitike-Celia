import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function inicializarBaseDados() {
  const db = await open({
    filename: './xitike.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS grupos (
      id_grupo TEXT PRIMARY KEY,
      nome_grupo TEXT NOT NULL,
      valor_diario REAL NOT NULL,
      dias_ciclo INTEGER NOT NULL,
      rodada_atual INTEGER DEFAULT 1,
      codigo TEXT UNIQUE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS membros (
      id_whatsapp TEXT NOT NULL,
      id_grupo TEXT NOT NULL,
      nome TEXT NOT NULL,
      total_pago REAL DEFAULT 0.0,
      divida REAL DEFAULT 0.0,
      credito REAL DEFAULT 0.0,
      ultimo_pagamento TEXT,
      ordem INTEGER,
      ultima_rodada_recebida INTEGER,
      numero_pagamento TEXT,
      PRIMARY KEY (id_whatsapp, id_grupo),
      FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sms_celia (
      id_transacao TEXT PRIMARY KEY,
      valor REAL NOT NULL,
      remetente_nome TEXT,
      remetente_numero TEXT,
      usado INTEGER DEFAULT 0,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reivindicacoes_pendentes (
      id_transacao TEXT PRIMARY KEY,
      id_grupo TEXT NOT NULL,
      remetente TEXT NOT NULL,
      valor REAL NOT NULL,
      nome_contato TEXT,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo)
    )
  `);


  await db.exec(`
    CREATE TABLE IF NOT EXISTS membros_bloqueados (
      id_whatsapp TEXT NOT NULL,
      id_grupo TEXT NOT NULL,
      nome TEXT,
      motivo TEXT,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id_whatsapp, id_grupo),
      FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS mensagens_nao_reconhecidas (
      id_grupo TEXT NOT NULL,
      remetente TEXT,
      nome_contato TEXT,
      texto TEXT,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS pagamentos_pendentes (
      id_transacao TEXT PRIMARY KEY,
      id_grupo TEXT NOT NULL,
      valor REAL NOT NULL,
      remetente_numero TEXT,
      remetente_nome TEXT,
      mensagem_bruta TEXT,
      data_recebimento TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sms_recebidos (
      id_transacao TEXT PRIMARY KEY,
      id_grupo TEXT,
      remetente TEXT NOT NULL,
      valor REAL NOT NULL,
      rede TEXT,
      destino TEXT,
      mensagem_bruta TEXT,
      data_recebimento TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'CONFIRMADO'
    )
  `);
  // Registo de auditoria de toda confirmação processada (evita duplicados).

  console.log("Base de dados do Xitike criada/atualizada com sucesso!");
  await db.close();
}

inicializarBaseDados();
