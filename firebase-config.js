// ============================================================
// firebase-config.js — Configuração do Firebase (REST API)
// Extensão: Pausa IA — Dr. Melo
// ============================================================
//
// Usamos a REST API do Firebase Realtime Database em vez do SDK
// para manter a extensão simples e compatível com MV3.
//
// Endpoints REST:
//  GET    /path.json              → lê dados
//  POST   /path.json   + body     → push (chave automática)
//  DELETE /path/chave.json        → remove item
// ============================================================

const FIREBASE_DB_URL = "https://oftautomacao-9b427-default-rtdb.firebaseio.com";
const FIREBASE_PATH   = "/DRM/agendamentoWhatsApp/configuracoes/cancelados";
