// ============================================================
// popup.js — Lógica do popup da extensão
// Extensão: Pausa IA — Dr. Melo
// ============================================================
//
// O popup se comunica com o content.js via chrome.tabs.sendMessage
// para obter o estado atual e executar ações (pausar / reativar).
//
// Mensagens enviadas ao content.js:
//   { action: 'GET_STATUS' }         → retorna o estado atual
//   { action: 'PAUSAR_IA'  }         → pausa a IA no Firebase
//   { action: 'REATIVAR_IA' }        → reativa a IA no Firebase
// ============================================================

'use strict';

// ──────────────────────────────────────────────
// Elementos do DOM
// ──────────────────────────────────────────────
const elTabDot      = document.getElementById('tab-dot');
const elTabLabel    = document.getElementById('tab-label');
const elContactCard = document.getElementById('contact-card');
const elContactContent = document.getElementById('contact-content');
const elBadge       = document.getElementById('ia-badge');
const elBadgeEmoji  = document.getElementById('badge-emoji');
const elBadgeMain   = document.getElementById('badge-main');
const elBadgeSub    = document.getElementById('badge-sub');
const elBadgeRight  = document.getElementById('badge-right');
const elBtn         = document.getElementById('btn-acao');
const elFeedback    = document.getElementById('feedback');

// Estado local do popup
let estadoAtual = null;
let tabId       = null;

// ──────────────────────────────────────────────
// Utilitários de UI
// ──────────────────────────────────────────────

function setFeedback(msg, duracao = 3000) {
  elFeedback.textContent = msg;
  if (duracao > 0) {
    setTimeout(() => { elFeedback.textContent = ''; }, duracao);
  }
}

function setBotaoCarregando(carregando) {
  elBtn.disabled = carregando;
  if (carregando) {
    elBtn.innerHTML = '<span class="spinner"></span> Aguarde...';
  }
}

// ──────────────────────────────────────────────
// Atualizar interface com o estado recebido
// ──────────────────────────────────────────────

function renderizarEstado(estado) {
  estadoAtual = estado;

  // ── Contato ──
  if (estado.numeroFormatado) {
    // Tem contato
    elContactContent.innerHTML = `
      <div class="contact-nome">${escapeHtml(estado.nomeContato || 'Contato')}</div>
      <div class="contact-numero">${escapeHtml(estado.numeroExibido || estado.numeroFormatado)}</div>
    `;

    // ── Badge de status ──
    elBadge.className = 'ia-status-badge ' + (estado.iaPausada ? 'pausada' : 'ativa');

    if (estado.iaPausada) {
      elBadgeEmoji.textContent = '🔴';
      elBadgeMain.textContent  = 'IA PAUSADA';
      elBadgeSub.textContent   = 'Sem resposta automática';
      elBadgeRight.textContent = '●';
    } else {
      elBadgeEmoji.textContent = '🟢';
      elBadgeMain.textContent  = 'IA ATIVA';
      elBadgeSub.textContent   = 'Respondendo normalmente';
      elBadgeRight.textContent = '●';
    }

    // ── Botão ──
    elBtn.disabled = false;
    if (estado.iaPausada) {
      elBtn.textContent = '🟢 Reativar IA para este Paciente';
      elBtn.className   = 'btn-acao reativar';
    } else {
      elBtn.textContent = '🔴 Pausar IA para este Paciente';
      elBtn.className   = 'btn-acao pausar';
    }

  } else {
    // Sem contato detectado
    elContactContent.innerHTML = '<span class="contact-vazio">Nenhuma conversa aberta</span>';

    elBadge.className       = 'ia-status-badge desconhecida';
    elBadgeEmoji.textContent = '⏳';
    elBadgeMain.textContent  = 'Aguardando...';
    elBadgeSub.textContent   = 'Abra uma conversa no WhatsApp';
    elBadgeRight.textContent = '';

    elBtn.disabled    = true;
    elBtn.textContent = 'Pausar IA para este Paciente';
    elBtn.className   = 'btn-acao pausar';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────
// Comunicação com o content.js
// ──────────────────────────────────────────────

async function obterTabWhatsApp() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, tabs => {
      if (tabs && tabs.length > 0) {
        resolve(tabs[0]);
      } else {
        resolve(null);
      }
    });
  });
}

async function enviarMensagem(acao) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: acao }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ──────────────────────────────────────────────
// Inicialização do popup
// ──────────────────────────────────────────────

async function inicializar() {
  // Encontra a aba do WhatsApp Web
  const tab = await obterTabWhatsApp();

  if (!tab) {
    // WhatsApp Web não está aberto
    elTabDot.className   = 'tab-dot inativo';
    elTabLabel.textContent = 'WhatsApp Web não está aberto';
    elBtn.disabled = true;
    setFeedback('Abra o WhatsApp Web para usar esta extensão.', 0);
    return;
  }

  tabId = tab.id;
  elTabDot.className    = 'tab-dot ativo';
  elTabLabel.textContent = 'WhatsApp Web ativo ✓';

  // Solicita o estado atual ao content.js
  try {
    const resp = await enviarMensagem('GET_STATUS');
    if (resp && resp.estado) {
      renderizarEstado(resp.estado);
    }
  } catch (erro) {
    console.warn('[Pausa IA Popup] content.js ainda não respondeu:', erro.message);
    setFeedback('⚠️ Recarregue o WhatsApp Web e tente novamente.', 0);
  }
}

// ──────────────────────────────────────────────
// Ação do botão
// ──────────────────────────────────────────────

elBtn.addEventListener('click', async () => {
  if (!estadoAtual || !estadoAtual.numeroFormatado) return;

  const acao = estadoAtual.iaPausada ? 'REATIVAR_IA' : 'PAUSAR_IA';

  setBotaoCarregando(true);
  setFeedback('');

  try {
    const resp = await enviarMensagem(acao);
    if (resp && resp.sucesso && resp.estado) {
      renderizarEstado(resp.estado);
      const msg = resp.estado.iaPausada
        ? '🔴 IA pausada com sucesso!'
        : '🟢 IA reativada com sucesso!';
      setFeedback(msg);
    } else if (resp && resp.erro) {
      setFeedback('❌ ' + resp.erro);
      setBotaoCarregando(false);
    }
  } catch (erro) {
    console.error('[Pausa IA Popup] Erro:', erro);
    setFeedback('❌ Erro ao comunicar com a extensão.');
    setBotaoCarregando(false);
  }
});

// ──────────────────────────────────────────────
// Inicia quando o popup abre
// ──────────────────────────────────────────────
inicializar();
