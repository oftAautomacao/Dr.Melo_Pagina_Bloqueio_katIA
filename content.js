// ============================================================
// content.js — Script principal injetado no WhatsApp Web
// Extensão: Pausa IA — Dr. Melo
// ============================================================
//
// Responsabilidades:
//  1. Criar e exibir o widget flutuante no WhatsApp Web
//  2. Detectar o contato atual via DOM (MutationObserver + URL)
//  3. Consultar Firebase para saber se a IA está pausada
//  4. Pausar / reativar a IA gravando/removendo no Firebase
//
// Firebase: REST API via fetch (sem SDK — compatível com MV3)
// Nó: /DRM/agendamentoWhatsApp/configuracoes/cancelados
// ============================================================

'use strict';

// (Configurações agora vêm do firebase-config.js, injetado antes pelo manifest)
// FIREBASE_DB_URL e FIREBASE_PATH são definidos lá.
const FIREBASE_CONVERSAS_PATH = "/DRM/agendamentoWhatsApp/operacional/conversas";
const STORAGE_MOTIVOS_NAO_AGENDAMENTO = 'pausa_ia_motivos_nao_agendamento';
const MOTIVOS_NAO_AGENDAMENTO_PADRAO = [
  'Paciente desistiu',
  'Sem horario disponivel',
  'Convenio nao atendido',
  'Nao respondeu',
  'Solicitou retorno posterior',
];

// ──────────────────────────────────────────────
// Estado global do widget
// ──────────────────────────────────────────────
let estadoAtual = {
  numeroFormatado : null,   // ex: "5521977164257"
  nomeContato     : null,   // ex: "João Silva"
  numeroExibido   : null,   // ex: "+55 21 97716-4257"
  iaPausada       : false,
  chaveFirebase   : null,   // chave do item no Firebase (para deletar)
  motivoNaoAgendamento: null,
  carregando      : false,
  numeroManual    : null,   // Guarda o número inserido manualmente
  statusSincronizado: false,
};

estadoAtual.entradaManualAtiva = false;

let observerDOM = null;
let timerDebounce = null;
let painelBloqueadosEl = null;
let recarregarListaBloqueados = async () => {};
let intervaloLeituraAutomatica = null;
let motivoSelecionado = '';

// ──────────────────────────────────────────────
// Utilitários Firebase (REST API)
// ──────────────────────────────────────────────

/** Verifica se um número específico está na lista de cancelados */
async function fbConsultarCancelado(numero) {
  const resp = await fetch(`${FIREBASE_DB_URL}${FIREBASE_PATH}/${numero}.json`);
  if (!resp.ok) throw new Error(`Firebase GET falhou: ${resp.status}`);
  return await resp.json(); // Retorna os dados se existir, ou null
}

async function fbListarCancelados() {
  const resp = await fetch(`${FIREBASE_DB_URL}${FIREBASE_PATH}.json`);
  if (!resp.ok) throw new Error(`Firebase GET lista falhou: ${resp.status}`);
  return await resp.json();
}

async function fbSalvarMotivoNaoAgendamento(telefone, motivoNaoAgendamento) {
  const resp = await fetch(`${FIREBASE_DB_URL}${FIREBASE_CONVERSAS_PATH}/${telefone}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motivoNaoAgendamento }),
  });
  if (!resp.ok) throw new Error(`Firebase PATCH motivo falhou: ${resp.status}`);
  return await resp.json();
}

/** Adiciona um novo cancelado (usando o próprio número como chave via PUT) */
async function fbConsultarMotivoNaoAgendamento(telefone) {
  const resp = await fetch(`${FIREBASE_DB_URL}${FIREBASE_CONVERSAS_PATH}/${telefone}/motivoNaoAgendamento.json`);
  if (!resp.ok) throw new Error(`Firebase GET motivo falhou: ${resp.status}`);
  return await resp.json();
}

async function fbAdicionarCancelado(descricao, telefone, nomeContato = null) {
  const payload = { descricao, telefone };
  if (nomeContato) {
    payload.nomeContatoNormalizado = normalizarNome(nomeContato);
  }

  const resp = await fetch(`${FIREBASE_DB_URL}${FIREBASE_PATH}/${telefone}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Firebase PUT falhou: ${resp.status}`);
  return telefone; // retorna a própria chave (o telefone)
}

/** Remove um item do nó /cancelados usando o telefone como chave */
async function fbRemoverCancelado(telefone) {
  const resp = await fetch(`${FIREBASE_DB_URL}${FIREBASE_PATH}/${telefone}.json`, {
    method: 'DELETE',
  });
  if (!resp.ok) throw new Error(`Firebase DELETE falhou: ${resp.status}`);
}

/** Busca a chave do item que tem telefone === numero */
async function fbBuscarChavePorTelefone(numero) {
  const dados = await fbConsultarCancelado(numero);
  if (dados) return numero; // Se retornou dados, a chave (o próprio número) existe
  return null;
}

function lerStorageLocal(chave) {
  return new Promise((resolve) => {
    if (chrome?.storage?.local) {
      chrome.storage.local.get([chave], (resultado) => {
        resolve(resultado?.[chave]);
      });
      return;
    }

    try {
      const valor = localStorage.getItem(chave);
      resolve(valor ? JSON.parse(valor) : null);
    } catch (erro) {
      console.error('[Pausa IA] Erro ao ler storage local:', erro);
      resolve(null);
    }
  });
}

function salvarStorageLocal(chave, valor) {
  return new Promise((resolve, reject) => {
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ [chave]: valor }, () => {
        if (chrome.runtime?.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
      return;
    }

    try {
      localStorage.setItem(chave, JSON.stringify(valor));
      resolve();
    } catch (erro) {
      reject(erro);
    }
  });
}

// ──────────────────────────────────────────────
// Utilitários de número
// ──────────────────────────────────────────────

/**
 * Remove tudo que não for dígito e normaliza para o padrão:
 *   55 + DDD + número
 *
 * Regras:
 * - 8 ou 9 dígitos: assume DDD 21 e adiciona 55
 * - 10 ou 11 dígitos: assume que já tem DDD e adiciona 55
 * - 12 ou 13 dígitos iniciando com 55: mantém como está
 * - Remove zeros à esquerda comuns em prefixos de discagem (ex: 021...)
 */
async function fbBuscarCanceladoPorNome(nomeContato) {
  const nomeNormalizado = normalizarNome(nomeContato);
  if (!nomeNormalizado) return null;

  const dados = await fbListarCancelados();
  if (!dados || typeof dados !== 'object') return null;

  for (const [telefone, item] of Object.entries(dados)) {
    if (!item || typeof item !== 'object') continue;

    const nomeItem = item.nomeContatoNormalizado || normalizarNome(item.nomeContato || '');
    if (nomeItem === nomeNormalizado) {
      return {
        telefone,
        descricao: item.descricao || null,
      };
    }
  }

  return null;
}

function formatarNumero(raw) {
  let limpo = String(raw || '').replace(/[^0-9]/g, '');

  limpo = limpo.replace(/^0+/, '');

  if (limpo.startsWith('55') && (limpo.length === 12 || limpo.length === 13)) {
    return limpo;
  }

  if (limpo.length === 8 || limpo.length === 9) {
    return '5521' + limpo;
  }

  if (limpo.length === 10 || limpo.length === 11) {
    return '55' + limpo;
  }

  return limpo;
}

/** Verifica se o número já está no padrão 55 + DDD + número */
function pareceNumeroValido(num) {
  return /^55\d{10,11}$/.test(num);
}

function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function normalizarTextoLista(valor) {
  return String(valor || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function chaveTextoLista(valor) {
  return normalizarTextoLista(valor).toLowerCase();
}

async function carregarMotivosNaoAgendamento() {
  const salvos = await lerStorageLocal(STORAGE_MOTIVOS_NAO_AGENDAMENTO);
  const origem = Array.isArray(salvos)
    ? salvos
    : MOTIVOS_NAO_AGENDAMENTO_PADRAO;

  const vistos = new Set();
  const motivos = [];
  for (const item of origem) {
    const texto = normalizarTextoLista(item);
    if (!texto) continue;

    const chave = chaveTextoLista(texto);
    if (vistos.has(chave)) continue;

    vistos.add(chave);
    motivos.push(texto);
  }

  if (!Array.isArray(salvos) || salvos.length !== motivos.length) {
    await salvarStorageLocal(STORAGE_MOTIVOS_NAO_AGENDAMENTO, motivos);
  }

  return motivos;
}

async function salvarMotivosNaoAgendamento(motivos) {
  const vistos = new Set();
  const limpos = [];

  for (const item of motivos) {
    const texto = normalizarTextoLista(item);
    if (!texto) continue;

    const chave = chaveTextoLista(texto);
    if (vistos.has(chave)) continue;

    vistos.add(chave);
    limpos.push(texto);
  }

  await salvarStorageLocal(STORAGE_MOTIVOS_NAO_AGENDAMENTO, limpos);
  return limpos;
}

function ehTextoStatusContato(texto) {
  const nome = normalizarNome(texto);
  if (!nome) return true;

  return (
    nome.startsWith('visto por ultimo') ||
    nome === 'online' ||
    nome.startsWith('digitando') ||
    nome.startsWith('gravando audio') ||
    nome.startsWith('gravando video') ||
    nome.startsWith('tocando') ||
    nome.startsWith('clique aqui')
  );
}

function ehTelefoneFirebaseValido(valor) {
  if (typeof valor !== 'string') return false;

  const texto = valor.trim();
  if (!texto) return false;

  const textoMinusculo = texto.toLowerCase();
  return (
    /\d/.test(texto) &&
    !texto.includes('-') &&
    !texto.includes('@') &&
    !textoMinusculo.includes('group')
  );
}

function extrairTelefoneValidoDoRegistro(chave, item) {
  if (item && ehTelefoneFirebaseValido(item.telefone)) {
    return item.telefone.trim();
  }

  if (ehTelefoneFirebaseValido(chave)) {
    return chave.trim();
  }

  return null;
}

// ──────────────────────────────────────────────
// Detecção do contato atual no WhatsApp Web
// ──────────────────────────────────────────────

/**
 * Tenta varrer as propriedades ocultas do React (Fiber) dos elementos da tela
 * para achar o JID do WhatsApp (ex: 5521912345678@c.us).
 * Isso permite achar o número mesmo se o contato estiver salvo na agenda e o
 * WhatsApp esconder o número do HTML visível.
 */
function extrairNumeroViaReact() {
  try {
    const header = document.querySelector('#main header');
    if (!header) return null;

    // Vasculha todos os elementos dentro do header
    const elementos = [header, ...header.querySelectorAll('*')];
    
    for (const el of elementos) {
      // Procura a chave interna do React (começa com __reactFiber$)
      const chaveFiber = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!chaveFiber) continue;
      
      let nodo = el[chaveFiber];
      let tentativas = 0;
      
      // Sobe até 15 níveis na árvore do React em busca das props originais do contato
      while (nodo && tentativas < 15) {
        if (nodo.memoizedProps) {
          // Tenta pegar o ID direto (forma segura se não quiser fazer stringify em tudo)
          const jid = nodo.memoizedProps?.chat?.id || nodo.memoizedProps?.contact?.id || nodo.memoizedProps?.user?.id;
          if (jid && typeof jid === 'string' && jid.endsWith('@c.us')) {
            return jid.replace('@c.us', '');
          }

          // Fallback brutal: stringify e regex (acha o padrão JID do WhatsApp em qualquer prop)
          const propsString = JSON.stringify(nodo.memoizedProps);
          const match = propsString.match(/"(\d{10,15})@c\.us"/);
          if (match && match[1]) {
            return match[1]; 
          }
        }
        nodo = nodo.return; 
        tentativas++;
      }
    }
  } catch (erro) {
    console.error('[Pausa IA] Erro ao buscar número no React:', erro);
  }
  return null;
}

/**
 * Tenta extrair o número de telefone e o nome do contato aberto no WhatsApp Web.
 * Retorna { nome, numeroRaw, numeroFormatado } ou null se não encontrar.
 */
function detectarNomeContato() {
  const seletoresNome = [
    '#main header [data-testid="conversation-info-header-chat-title"]',
    '#main header [data-testid="conversation-info-header-chat-title"] span',
    '#main header div[role="button"] span[title]',
    '#main header div[role="button"] span[dir="auto"][title]',
    '#main header div[role="button"] span[dir="auto"]',
    '#main header span[title]:not([data-icon])',
    '#main header span[dir="auto"]',
    'header ._21S-L span',
    'header [class*="conversation-info"] span[dir="auto"]',
  ];

  for (const sel of seletoresNome) {
    const elementos = document.querySelectorAll(sel);
    for (const el of elementos) {
      const candidato = (el.getAttribute('title') || el.textContent || '').trim();
      if (candidato && !ehTextoStatusContato(candidato)) {
        return candidato;
      }
    }
  }

  return null;
}

function detectarContato() {
  // ── 1. Nome do contato (cabeçalho da conversa) ──
  const nome = detectarNomeContato();

  // ── 2. Número de telefone ──
  let numeroRaw = null;

  // ESTRATÉGIA SUPREMA: Ler propriedades originais do React Fiber
  // Resolve o problema de contatos salvos sem precisar abrir painel lateral
  const numeroReact = extrairNumeroViaReact();
  if (numeroReact && pareceNumeroValido(numeroReact)) {
    numeroRaw = numeroReact;
  }

  // Estratégia A: painel de informações do contato (se aberto)
  if (!numeroRaw) {
    const seletoresNumero = [
      'div[data-testid="contact-info-phone"] span',
      'span[data-testid="contact-info-phone"]',
      '[aria-label*="phone"] span',
      '[data-testid*="phone"] span',
    ];
    for (const sel of seletoresNumero) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        const candidato = formatarNumero(el.textContent.trim());
        if (pareceNumeroValido(candidato)) {
          numeroRaw = el.textContent.trim();
          break;
        }
      }
    }
  }

  // Estratégia B: varrer todos os elementos visíveis na tela (Regex)
  if (!numeroRaw) {
    const padraoTelBR = /(\+55[\s\-]?\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})/;
    const walker = document.createTreeWalker(
      document.querySelector('#main') || document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    while ((node = walker.nextNode())) {
      const texto = node.textContent.trim();
      const match = texto.match(padraoTelBR);
      if (match) {
        numeroRaw = match[1];
        break;
      }
    }
  }

  // Estratégia C: extrair da URL
  if (!numeroRaw) {
    const urlMatch = window.location.href.match(/[?&]phone=(\d+)/);
    if (urlMatch) numeroRaw = urlMatch[1];
  }

  // Estratégia D: extrair do hash da URL
  if (!numeroRaw) {
    const hashMatch = window.location.hash.match(/#\/(\d+)@/);
    if (hashMatch) numeroRaw = hashMatch[1];
  }

  if (!numeroRaw) return null;

  const numeroFormatado = formatarNumero(String(numeroRaw));
  if (!pareceNumeroValido(numeroFormatado)) return null;

  return { nome: nome || 'Contato', numeroRaw: String(numeroRaw), numeroFormatado };
}

// ──────────────────────────────────────────────
// Criação do Widget
// ──────────────────────────────────────────────

function criarWidget() {
  if (document.getElementById('pausa-ia-widget')) return;

  const widget = document.createElement('div');
  widget.id = 'pausa-ia-widget';
  widget.className = 'sem-contato';
  
  const topPos = localStorage.getItem('pausa_ia_top') || '20px';
  const leftPos = localStorage.getItem('pausa_ia_left') || (window.innerWidth - 300) + 'px';
  
  widget.style.top = topPos;
  widget.style.left = leftPos;
  widget.style.right = 'auto'; // Remove o right padrão do CSS para usar left

  widget.innerHTML = `
    <div id="pausa-ia-toast"></div>
    <div id="pausa-ia-card" title="Arraste para mover">
      <button id="pausa-ia-switch" type="button" title="Clique para pausar ou reativar a IA" aria-pressed="false">
        <span id="pausa-ia-icon">🤖</span>
        <span id="pausa-ia-title">IA</span>
        <span id="pausa-ia-slider"></span>
        <span id="pausa-ia-status-flash" aria-live="polite"></span>
      </button>
      <div class="pausa-ia-divider"></div>
      <span id="pausa-ia-numero" title="Clique para inserir manualmente">—</span>
      <input type="text" id="pausa-ia-input-manual" placeholder="Cole o telefone" maxlength="20" />
      <div class="pausa-ia-divider"></div>
      <button id="btn-bloqueados" title="Abrir painel">▾</button>
    </div>
    <div id="pausa-ia-painel" hidden>
      <div class="pausa-ia-painel-header">Acoes rapidas</div>
      <div class="pausa-ia-painel-body">
        <button type="button" class="pausa-ia-painel-opcao" data-secao="bloqueados" aria-expanded="false">
          <span>Cancelados</span>
          <span class="pausa-ia-painel-seta">▾</span>
        </button>
        <div class="pausa-ia-painel-secao" id="pausa-ia-secao-bloqueados" hidden>
          <div id="pausa-ia-bloqueados-lista"></div>
        </div>
        <button type="button" class="pausa-ia-painel-opcao" data-secao="nao-agendado" aria-expanded="false">
          <span>Paciente nao agendado</span>
          <span class="pausa-ia-painel-seta">▾</span>
        </button>
        <div class="pausa-ia-painel-secao" id="pausa-ia-secao-nao-agendado" hidden>
          <div id="pausa-ia-nao-agendado-status" class="pausa-ia-bloqueados-info">Nenhum contato detectado no momento.</div>
          <div class="pausa-ia-motivo-picker">
            <button type="button" id="btn-motivo-select" aria-expanded="false">
              <span id="pausa-ia-motivo-select-texto">Selecione um motivo</span>
              <span class="pausa-ia-painel-seta">▾</span>
            </button>
            <div id="pausa-ia-motivo-dropdown" hidden>
              <div class="pausa-ia-motivo-dropdown-layout">
                <div id="pausa-ia-motivo-opcoes"></div>
                <div class="pausa-ia-motivo-dropdown-acoes">
                  <button type="button" id="btn-editar-motivos" class="pausa-ia-motivo-dropdown-editar" title="Editar motivos" aria-expanded="false">
                    <span class="pausa-ia-editor-icone">&#9998;</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <button type="button" id="btn-salvar-nao-agendado">Salvar motivo</button>
          <div id="pausa-ia-motivo-salvo-status" class="pausa-ia-bloqueados-info" hidden></div>
          <div id="pausa-ia-editor-motivos" hidden>
            <div id="pausa-ia-motivos-lista"></div>
            <div class="pausa-ia-motivos-novo">
              <input type="text" id="pausa-ia-motivo-novo" placeholder="Novo motivo" maxlength="80" />
              <button type="button" id="btn-adicionar-motivo" title="Adicionar motivo">+</button>
              <button type="button" id="btn-salvar-motivos" title="Salvar motivos">Salvar</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(widget);
  document.getElementById('pausa-ia-switch').addEventListener('click', async (e) => {
    e.stopPropagation();
    await aoClicarToggle();
  });

  const painelBloqueados = document.getElementById('pausa-ia-painel');
  const listaBloqueados = document.getElementById('pausa-ia-bloqueados-lista');
  const btnBloqueados = document.getElementById('btn-bloqueados');
  const botoesPainel = Array.from(document.querySelectorAll('.pausa-ia-painel-opcao'));
  const secaoBloqueados = document.getElementById('pausa-ia-secao-bloqueados');
  const secaoNaoAgendado = document.getElementById('pausa-ia-secao-nao-agendado');
  const btnMotivoSelect = document.getElementById('btn-motivo-select');
  const textoMotivoSelect = document.getElementById('pausa-ia-motivo-select-texto');
  const dropdownMotivo = document.getElementById('pausa-ia-motivo-dropdown');
  const opcoesMotivo = document.getElementById('pausa-ia-motivo-opcoes');
  const btnSalvarNaoAgendado = document.getElementById('btn-salvar-nao-agendado');
  const listaMotivos = document.getElementById('pausa-ia-motivos-lista');
  const inputMotivoNovo = document.getElementById('pausa-ia-motivo-novo');
  const btnAdicionarMotivo = document.getElementById('btn-adicionar-motivo');
  const btnSalvarMotivos = document.getElementById('btn-salvar-motivos');
  const btnEditarMotivos = document.getElementById('btn-editar-motivos');
  const editorMotivos = document.getElementById('pausa-ia-editor-motivos');
  const statusNaoAgendado = document.getElementById('pausa-ia-nao-agendado-status');
  const statusMotivoSalvo = document.getElementById('pausa-ia-motivo-salvo-status');
  painelBloqueadosEl = painelBloqueados;
  let motivosNaoAgendamento = [];
  let motivosNaoAgendamentoEdicao = [];
  let timerBotaoMotivoSalvo = null;

  async function carregarBloqueados() {
    listaBloqueados.innerHTML = '<div class="pausa-ia-bloqueados-info">Carregando...</div>';

    try {
      const dados = await fbListarCancelados();
      const telefones = [];
      const vistos = new Set();

      if (dados && typeof dados === 'object') {
        for (const [chave, item] of Object.entries(dados)) {
          const telefone = extrairTelefoneValidoDoRegistro(chave, item);
          if (telefone && !vistos.has(telefone)) {
            vistos.add(telefone);
            telefones.push(telefone);
          }
        }
      }

      telefones.sort();

      if (telefones.length === 0) {
        listaBloqueados.innerHTML = '<div class="pausa-ia-bloqueados-info">Nenhum bloqueado válido.</div>';
        return;
      }

      listaBloqueados.innerHTML = telefones
        .map(telefone => `<button type="button" class="pausa-ia-bloqueado-item" data-telefone="${telefone}" title="Clique para copiar">${telefone}</button>`)
        .join('');
    } catch (erro) {
      console.error('[Pausa IA] Erro ao listar bloqueados:', erro);
      listaBloqueados.innerHTML = '<div class="pausa-ia-bloqueados-info">Erro ao carregar lista.</div>';
    }
  }

  recarregarListaBloqueados = carregarBloqueados;

  function atualizarStatusNaoAgendado() {
    const telefoneAtual = estadoAtual.numeroExibido || estadoAtual.numeroFormatado;
    const podeSalvar = Boolean(estadoAtual.numeroFormatado && motivoSelecionado);
    const motivoSalvo = normalizarTextoLista(estadoAtual.motivoNaoAgendamento);

    statusNaoAgendado.textContent = telefoneAtual
      ? `Contato atual: ${telefoneAtual}`
      : 'Nenhum contato detectado no momento.';

    if (statusMotivoSalvo) {
      if (telefoneAtual && motivoSalvo) {
        statusMotivoSalvo.textContent = `Motivo salvo: ${motivoSalvo}`;
        statusMotivoSalvo.removeAttribute('hidden');
      } else {
        statusMotivoSalvo.textContent = '';
        statusMotivoSalvo.setAttribute('hidden', '');
      }
    }

    btnSalvarNaoAgendado.disabled = !podeSalvar;
  }

  function animarConfirmacaoMotivoSalvo() {
    clearTimeout(timerBotaoMotivoSalvo);
    btnSalvarNaoAgendado.classList.remove('salvo');
    void btnSalvarNaoAgendado.offsetWidth;
    btnSalvarNaoAgendado.textContent = 'Motivo salvo';
    btnSalvarNaoAgendado.classList.add('salvo');

    timerBotaoMotivoSalvo = setTimeout(() => {
      btnSalvarNaoAgendado.classList.remove('salvo');
      btnSalvarNaoAgendado.textContent = 'Salvar motivo';
    }, 1600);
  }

  function escaparHtml(valor) {
    return String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function renderizarMotivosNaoAgendamento() {
    motivosNaoAgendamento = await carregarMotivosNaoAgendamento();
    if (motivoSelecionado && !motivosNaoAgendamento.some((motivo) => chaveTextoLista(motivo) === chaveTextoLista(motivoSelecionado))) {
      motivoSelecionado = '';
    }

    textoMotivoSelect.textContent = motivoSelecionado || 'Selecione um motivo';

    opcoesMotivo.innerHTML = motivosNaoAgendamento.length
      ? motivosNaoAgendamento
          .map((motivo) => {
            const valor = escaparHtml(motivo);
            const ativo = chaveTextoLista(motivo) === chaveTextoLista(motivoSelecionado);
            return `<button type="button" class="pausa-ia-motivo-opcao${ativo ? ' ativa' : ''}" data-motivo="${valor}">${valor}</button>`;
          })
          .join('')
      : '<div class="pausa-ia-bloqueados-info">Nenhum motivo cadastrado.</div>';

    if (!editorMotivos.hasAttribute('hidden')) {
      renderizarListaEditorMotivos();
    }

    atualizarStatusNaoAgendado();
  }

  function renderizarListaEditorMotivos() {
    listaMotivos.innerHTML = motivosNaoAgendamentoEdicao.length
      ? motivosNaoAgendamentoEdicao
          .map((motivo) => {
            const valor = escaparHtml(motivo);
            return `
              <div class="pausa-ia-motivo-item">
                <span class="pausa-ia-motivo-texto">${valor}</span>
                <button type="button" class="pausa-ia-motivo-remover" data-motivo="${valor}" title="Remover motivo">×</button>
              </div>
            `;
          })
          .join('')
      : '<div class="pausa-ia-bloqueados-info">Nenhum motivo cadastrado.</div>';
  }

  function atualizarEditorMotivos(aberto) {
    if (aberto) {
      motivosNaoAgendamentoEdicao = [...motivosNaoAgendamento];
      renderizarListaEditorMotivos();
      editorMotivos.removeAttribute('hidden');
      btnEditarMotivos.setAttribute('aria-expanded', 'true');
      btnEditarMotivos.classList.add('ativo');
      return;
    }

    editorMotivos.setAttribute('hidden', '');
    btnEditarMotivos.setAttribute('aria-expanded', 'false');
    btnEditarMotivos.classList.remove('ativo');
  }

  function atualizarDropdownMotivos(aberto) {
    if (aberto) {
      dropdownMotivo.removeAttribute('hidden');
      btnMotivoSelect.setAttribute('aria-expanded', 'true');
      return;
    }

    dropdownMotivo.setAttribute('hidden', '');
    btnMotivoSelect.setAttribute('aria-expanded', 'false');
  }

  function fecharSecoesPainel() {
    secaoBloqueados.setAttribute('hidden', '');
    secaoNaoAgendado.setAttribute('hidden', '');
    atualizarEditorMotivos(false);
    atualizarDropdownMotivos(false);

    for (const botao of botoesPainel) {
      botao.classList.remove('ativa');
      botao.setAttribute('aria-expanded', 'false');
      const seta = botao.querySelector('.pausa-ia-painel-seta');
      if (seta) seta.textContent = '▾';
    }
  }

  async function alternarSecaoPainel(nomeSecao) {
    const botao = botoesPainel.find((item) => item.dataset.secao === nomeSecao);
    const secao = nomeSecao === 'bloqueados' ? secaoBloqueados : secaoNaoAgendado;
    if (!botao || !secao) return;

    const estavaAberta = !secao.hasAttribute('hidden');
    fecharSecoesPainel();

    if (estavaAberta) return;

    secao.removeAttribute('hidden');
    botao.classList.add('ativa');
    botao.setAttribute('aria-expanded', 'true');
    const seta = botao.querySelector('.pausa-ia-painel-seta');
    if (seta) seta.textContent = '▴';

    if (nomeSecao === 'bloqueados') {
      await carregarBloqueados();
      return;
    }

    atualizarDropdownMotivos(false);
    try {
      await renderizarMotivosNaoAgendamento();
    } catch (erro) {
      console.error('[Pausa IA] Erro ao abrir motivos de nao agendamento:', erro);
      mostrarToast('Erro ao carregar motivos');
    }
  }

  listaBloqueados.addEventListener('click', async (e) => {
    const item = e.target.closest('.pausa-ia-bloqueado-item[data-telefone]');
    if (!item) return;

    const telefone = item.getAttribute('data-telefone');
    if (!telefone) return;

    try {
      await navigator.clipboard.writeText(telefone);
      mostrarToast(`Número copiado: ${telefone}`);
    } catch (erro) {
      console.error('[Pausa IA] Erro ao copiar número:', erro);
      mostrarToast('❌ Não foi possível copiar o número');
    }
  });

  btnBloqueados.addEventListener('click', async (e) => {
    e.stopPropagation();
    const abrir = painelBloqueados.hasAttribute('hidden');
    if (abrir) {
      painelBloqueados.removeAttribute('hidden');
      btnBloqueados.textContent = '▴';
      atualizarStatusNaoAgendado();
    } else {
      painelBloqueados.setAttribute('hidden', '');
      btnBloqueados.textContent = '▾';
      fecharSecoesPainel();
    }
  });

  // Painel de acoes e entrada manual
  for (const botao of botoesPainel) {
    botao.addEventListener('click', async (e) => {
      e.stopPropagation();
      await alternarSecaoPainel(botao.dataset.secao);
    });
  }

  btnSalvarNaoAgendado.addEventListener('click', async (e) => {
    e.stopPropagation();

    const motivo = normalizarTextoLista(motivoSelecionado);
    if (!motivo) {
      mostrarToast('Selecione um motivo');
      return;
    }

    if (!estadoAtual.numeroFormatado) {
      mostrarToast('Nenhum contato detectado');
      return;
    }

    try {
      await fbSalvarMotivoNaoAgendamento(estadoAtual.numeroFormatado, motivo);
      estadoAtual.motivoNaoAgendamento = motivo;
      motivoSelecionado = motivo;
      atualizarStatusNaoAgendado();
      animarConfirmacaoMotivoSalvo();
      mostrarToast(`Motivo salvo para ${estadoAtual.numeroFormatado}`);
    } catch (erro) {
      console.error('[Pausa IA] Erro ao salvar motivo de nao agendamento:', erro);
      mostrarToast('Erro ao salvar motivo');
    }
  });

  btnMotivoSelect.addEventListener('click', async (e) => {
    e.stopPropagation();
    const abrir = dropdownMotivo.hasAttribute('hidden');
    if (abrir) {
      await renderizarMotivosNaoAgendamento();
    }
    atualizarDropdownMotivos(abrir);
  });

  opcoesMotivo.addEventListener('click', (e) => {
    const botao = e.target.closest('.pausa-ia-motivo-opcao[data-motivo]');
    if (!botao) return;

    motivoSelecionado = normalizarTextoLista(botao.getAttribute('data-motivo'));
    textoMotivoSelect.textContent = motivoSelecionado || 'Selecione um motivo';
    atualizarDropdownMotivos(false);
    void renderizarMotivosNaoAgendamento();
  });

  btnEditarMotivos.addEventListener('click', (e) => {
    e.stopPropagation();
    atualizarDropdownMotivos(false);
    const abrir = editorMotivos.hasAttribute('hidden');
    atualizarEditorMotivos(abrir);
  });

  btnAdicionarMotivo.addEventListener('click', async (e) => {
    e.stopPropagation();

    try {
      const novoMotivo = normalizarTextoLista(inputMotivoNovo.value);
      if (!novoMotivo) return;

      const existe = motivosNaoAgendamentoEdicao.some((item) => chaveTextoLista(item) === chaveTextoLista(novoMotivo));
      if (existe) {
        mostrarToast('Esse motivo ja existe');
        inputMotivoNovo.value = '';
        return;
      }

      motivosNaoAgendamentoEdicao = [
        ...motivosNaoAgendamentoEdicao,
        novoMotivo,
      ];
      inputMotivoNovo.value = '';
      renderizarListaEditorMotivos();
    } catch (erro) {
      console.error('[Pausa IA] Erro ao adicionar motivo:', erro);
      mostrarToast('Erro ao adicionar motivo');
    }
  });

  inputMotivoNovo.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    btnAdicionarMotivo.click();
  });

  listaMotivos.addEventListener('click', async (e) => {
    const botao = e.target.closest('.pausa-ia-motivo-remover[data-motivo]');
    if (!botao) return;

    const motivo = botao.getAttribute('data-motivo');
    if (!motivo) return;

    try {
      motivosNaoAgendamentoEdicao = motivosNaoAgendamentoEdicao.filter(
        (item) => chaveTextoLista(item) !== chaveTextoLista(motivo)
      );
      renderizarListaEditorMotivos();
    } catch (erro) {
      console.error('[Pausa IA] Erro ao remover motivo:', erro);
      mostrarToast('Erro ao remover motivo');
    }
  });

  btnSalvarMotivos.addEventListener('click', async (e) => {
    e.stopPropagation();

    try {
      motivosNaoAgendamento = await salvarMotivosNaoAgendamento(motivosNaoAgendamentoEdicao);
      await renderizarMotivosNaoAgendamento();
      atualizarEditorMotivos(false);
      mostrarToast('Lista de motivos salva');
    } catch (erro) {
      console.error('[Pausa IA] Erro ao salvar lista de motivos:', erro);
      mostrarToast('Erro ao salvar lista');
    }
  });

  const elNumero = document.getElementById('pausa-ia-numero');
  const inputManual = document.getElementById('pausa-ia-input-manual');

  elNumero.addEventListener('click', (e) => {
    if (widget.classList.contains('sem-contato')) {
      e.stopPropagation();
      widget.classList.add('modo-manual');
      inputManual.value = '';
      inputManual.focus();
    }
  });

  function salvarNumeroManual() {
    widget.classList.remove('modo-manual');
    const valor = inputManual.value.trim();
    if (!valor) return;
    
    const numero = formatarNumero(valor);
    if (pareceNumeroValido(numero)) {
      const nomeVisivel = detectarNomeContato() || estadoAtual.nomeContato || 'Contato';
      estadoAtual.numeroManual = numero;
      estadoAtual.entradaManualAtiva = true;
      estadoAtual.nomeContato = nomeVisivel;
      estadoAtual.numeroFormatado = numero;
      estadoAtual.numeroExibido = numero;
      pausarNumeroManual(numero, nomeVisivel);
    } else {
      mostrarToast('Número inválido');
    }
  }

  inputManual.addEventListener('blur', salvarNumeroManual);
  inputManual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') salvarNumeroManual();
  });
  inputManual.addEventListener('paste', () => {
    setTimeout(salvarNumeroManual, 0);
  });

  // Lógica Drag and Drop
  const card = document.getElementById('pausa-ia-card');
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  card.addEventListener('mousedown', (e) => {
    // Ignora o clique se for nos botões ou checkbox (para não conflitar com a ação deles)
    if (
      e.target.closest('#pausa-ia-switch') ||
      e.target.closest('#btn-bloqueados') ||
      e.target.closest('#pausa-ia-input-manual') ||
      e.target.closest('#pausa-ia-painel')
    ) return; 
    
    isDragging = true;
    widget.classList.add('arrastando');
    offsetX = e.clientX - widget.getBoundingClientRect().left;
    offsetY = e.clientY - widget.getBoundingClientRect().top;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    let newX = e.clientX - offsetX;
    let newY = e.clientY - offsetY;
    
    // Limites da tela para não sumir o widget
    if (newX < 0) newX = 0;
    if (newY < 0) newY = 0;
    if (newX + widget.offsetWidth > window.innerWidth) newX = window.innerWidth - widget.offsetWidth;
    if (newY + widget.offsetHeight > window.innerHeight) newY = window.innerHeight - widget.offsetHeight;

    widget.style.left = newX + 'px';
    widget.style.top = newY + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      widget.classList.remove('arrastando');
      // Salva a nova posição
      localStorage.setItem('pausa_ia_left', widget.style.left);
      localStorage.setItem('pausa_ia_top', widget.style.top);
    }
  });
}

// ──────────────────────────────────────────────
// Atualização do Widget
// ──────────────────────────────────────────────

function atualizarWidget() {
  const widget   = document.getElementById('pausa-ia-widget');
  const elNumero = document.getElementById('pausa-ia-numero');
  const elTitulo = document.getElementById('pausa-ia-title');
  const elSwitch = document.getElementById('pausa-ia-switch');
  const statusNaoAgendado = document.getElementById('pausa-ia-nao-agendado-status');
  const statusMotivoSalvo = document.getElementById('pausa-ia-motivo-salvo-status');
  const btnMotivoSelect = document.getElementById('btn-motivo-select');
  const btnSalvarNaoAgendado = document.getElementById('btn-salvar-nao-agendado');
  if (!widget) return;

  const telefoneAtual = estadoAtual.numeroExibido || estadoAtual.numeroFormatado;
  const motivoSalvo = normalizarTextoLista(estadoAtual.motivoNaoAgendamento);
  if (statusNaoAgendado) {
    statusNaoAgendado.textContent = telefoneAtual
      ? `Contato atual: ${telefoneAtual}`
      : 'Nenhum contato detectado no momento.';
  }
  if (statusMotivoSalvo) {
    if (telefoneAtual && motivoSalvo) {
      statusMotivoSalvo.textContent = `Motivo salvo: ${motivoSalvo}`;
      statusMotivoSalvo.removeAttribute('hidden');
    } else {
      statusMotivoSalvo.textContent = '';
      statusMotivoSalvo.setAttribute('hidden', '');
    }
  }
  if (btnMotivoSelect) btnMotivoSelect.disabled = false;
  if (btnSalvarNaoAgendado) btnSalvarNaoAgendado.disabled = !(estadoAtual.numeroFormatado && motivoSelecionado);
  if (elSwitch) {
    elSwitch.setAttribute('aria-pressed', estadoAtual.iaPausada ? 'true' : 'false');
    elSwitch.setAttribute(
      'title',
      estadoAtual.iaPausada
        ? 'Clique para ativar a IA'
        : 'Clique para pausar a IA'
    );
  }

  // Remove todas as classes de estado
  widget.classList.remove('ia-ativa', 'ia-pausada', 'sem-contato', 'carregando');

  if (estadoAtual.carregando) {
    widget.classList.add('carregando');
    elNumero.textContent = 'Buscando...';
    if (elTitulo) elTitulo.textContent = 'IA';
    return;
  }

  if (!estadoAtual.numeroFormatado) {
    widget.classList.add('sem-contato');
    elNumero.textContent = 'Sem contato';
    if (elTitulo) elTitulo.textContent = 'IA';
    return;
  }

  elNumero.textContent = estadoAtual.numeroExibido || estadoAtual.numeroFormatado;

  if (estadoAtual.iaPausada) {
    widget.classList.add('ia-pausada');
    if (elTitulo) elTitulo.textContent = 'IA';
  } else {
    widget.classList.add('ia-ativa');
    if (elTitulo) elTitulo.textContent = 'IA';
  }
}

function mostrarToast(mensagem, duracao = 2500) {
  const toast = document.getElementById('pausa-ia-toast');
  if (!toast) return;
  toast.textContent = mensagem;
  toast.classList.add('visivel');
  setTimeout(() => toast.classList.remove('visivel'), duracao);
}

function agendarLeituraContato(atraso = 0) {
  clearTimeout(timerDebounce);
  timerDebounce = setTimeout(() => {
    void aoMudarConversa();
  }, atraso);
}

function precisaSincronizarContato() {
  if (estadoAtual.carregando) return false;

  const contato = detectarContato();
  const nomeVisivel = detectarNomeContato();

  if (contato && contato.numeroFormatado) {
    return (
      contato.numeroFormatado !== estadoAtual.numeroFormatado ||
      !estadoAtual.statusSincronizado
    );
  }

  if (estadoAtual.numeroManual) return false;

  if (nomeVisivel) {
    return (
      nomeVisivel !== estadoAtual.nomeContato ||
      !estadoAtual.statusSincronizado
    );
  }

  return Boolean(estadoAtual.numeroFormatado);
}

function animarControle(tipo) {
  const controle = document.getElementById('pausa-ia-switch');
  const status = document.getElementById('pausa-ia-status-flash');
  const widget = document.getElementById('pausa-ia-widget');
  if (!controle || !status || !widget) return;

  const classe = tipo === 'pausada' ? 'animar-pausada' : 'animar-ativa';
  const classeWidget = tipo === 'pausada' ? 'flash-pausada' : 'flash-ativa';
  const texto = tipo === 'pausada' ? 'PAUSADA' : 'ATIVADA';
  controle.classList.remove('animar-ativa', 'animar-pausada');
  status.classList.remove('animar-ativa', 'animar-pausada');
  widget.classList.remove('flash-ativa', 'flash-pausada');

  // Reinicia a animação mesmo em cliques consecutivos.
  void controle.offsetWidth;
  void status.offsetWidth;
  status.textContent = texto;
  controle.classList.add(classe);
  status.classList.add(classe);
  widget.classList.add(classeWidget);

  setTimeout(() => {
    controle.classList.remove(classe);
    status.classList.remove(classe);
    widget.classList.remove(classeWidget);
    status.textContent = '';
  }, 1000);
}

// ──────────────────────────────────────────────
// Lógica do Toggle
// ──────────────────────────────────────────────

async function pausarNumeroManual(numero, nomeContato) {
  estadoAtual.carregando = true;
  atualizarWidget();

  try {
    const descricao = 'Pausado via Extensão';
    await fbAdicionarCancelado(descricao, numero, nomeContato);

    estadoAtual.chaveFirebase = numero;
    estadoAtual.iaPausada = true;
    estadoAtual.statusSincronizado = true;
    animarControle('pausada');
    if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
      await recarregarListaBloqueados();
    }
    mostrarToast('🔴 IA pausada para este paciente');
  } catch (erro) {
    console.error('[Pausa IA] Erro ao salvar nÃºmero manual:', erro);
    estadoAtual.iaPausada = false;
    estadoAtual.chaveFirebase = null;
    estadoAtual.statusSincronizado = false;
    mostrarToast('❌ Erro ao salvar no Firebase');
  } finally {
    estadoAtual.carregando = false;
    atualizarWidget();
  }
}

async function aoClicarToggle() {
  // Impede ação se não houver contato detectado
  if (!estadoAtual.numeroFormatado) {
    mostrarToast('⚠️ Nenhum contato detectado');
    return;
  }

  const querPausar = !estadoAtual.iaPausada;

  estadoAtual.carregando = true;
  atualizarWidget();

  try {
    if (querPausar) {
      // ── PAUSAR: adicionar no Firebase ──
      const descricao = 'Pausado via Extensão';

      const chave = await fbAdicionarCancelado(
        descricao,
        estadoAtual.numeroFormatado,
        estadoAtual.entradaManualAtiva ? estadoAtual.nomeContato : null
      );
      estadoAtual.chaveFirebase = chave;
      estadoAtual.iaPausada = true;
      estadoAtual.statusSincronizado = true;
      animarControle('pausada');
      if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
        await recarregarListaBloqueados();
      }
      mostrarToast('🔴 IA pausada para este paciente');
    } else {
      // ── REATIVAR: remover do Firebase ──
      // Usa a chave salva ou busca novamente (caso a extensão tenha sido recarregada)
      let chave = estadoAtual.chaveFirebase;
      if (!chave) {
        chave = await fbBuscarChavePorTelefone(estadoAtual.numeroFormatado);
      }
      if (chave) {
        await fbRemoverCancelado(chave);
        estadoAtual.chaveFirebase = null;
      }
      estadoAtual.iaPausada = false;
      estadoAtual.statusSincronizado = true;
      animarControle('ativa');
      if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
        await recarregarListaBloqueados();
      }
      mostrarToast('🟢 IA reativada para este paciente');
    }
  } catch (erro) {
    console.error('[Pausa IA] Erro ao comunicar com Firebase:', erro);
    estadoAtual.statusSincronizado = false;
    mostrarToast('❌ Erro ao conectar com Firebase');
  } finally {
    estadoAtual.carregando = false;
    atualizarWidget();
  }
}

// ──────────────────────────────────────────────
// Verificação de status no Firebase
// ──────────────────────────────────────────────

async function verificarStatusNoFirebase(numero) {
  estadoAtual.carregando = true;
  atualizarWidget();
  try {
    const [chave, motivoSalvo] = await Promise.all([
      fbBuscarChavePorTelefone(numero),
      fbConsultarMotivoNaoAgendamento(numero),
    ]);
    estadoAtual.iaPausada     = chave !== null;
    estadoAtual.chaveFirebase = chave;
    estadoAtual.motivoNaoAgendamento = normalizarTextoLista(motivoSalvo);
    motivoSelecionado = estadoAtual.motivoNaoAgendamento || '';
    estadoAtual.statusSincronizado = true;
  } catch (erro) {
    console.error('[Pausa IA] Erro ao verificar Firebase:', erro);
    estadoAtual.iaPausada     = false;
    estadoAtual.chaveFirebase = null;
    estadoAtual.motivoNaoAgendamento = null;
    motivoSelecionado = '';
    estadoAtual.statusSincronizado = false;
  } finally {
    estadoAtual.carregando = false;
    atualizarWidget();
  }
}

// ──────────────────────────────────────────────
// Detecção de mudança de conversa
// ──────────────────────────────────────────────

async function aoMudarConversa() {
  const contato = detectarContato();
  const nomeVisivel = detectarNomeContato();

  // Se encontrou contato válido na tela, limpa o manual
  if (contato && contato.numeroFormatado) {
    estadoAtual.numeroManual = null;
    estadoAtual.entradaManualAtiva = false;
  }

  // Se mesmo número, não faz nada
  if (
    contato &&
    contato.numeroFormatado === estadoAtual.numeroFormatado &&
    estadoAtual.statusSincronizado
  ) return;

  if (!contato) {
    if (estadoAtual.numeroManual) return; // Não apaga se estiver usando modo manual

    if (nomeVisivel) {
      try {
        const vinculo = await fbBuscarCanceladoPorNome(nomeVisivel);
        if (vinculo && pareceNumeroValido(vinculo.telefone)) {
          estadoAtual.numeroFormatado = vinculo.telefone;
          estadoAtual.nomeContato     = nomeVisivel;
          estadoAtual.numeroExibido   = vinculo.telefone;
          estadoAtual.iaPausada       = true;
          estadoAtual.chaveFirebase   = vinculo.telefone;
          estadoAtual.entradaManualAtiva = true;
          await verificarStatusNoFirebase(vinculo.telefone);
          return;
        }
      } catch (erro) {
        console.error('[Pausa IA] Erro ao buscar vínculo por nome:', erro);
        estadoAtual.statusSincronizado = false;
      }
    }

    estadoAtual.numeroFormatado = null;
    estadoAtual.nomeContato     = nomeVisivel;
    estadoAtual.numeroExibido   = null;
    estadoAtual.iaPausada       = false;
    estadoAtual.chaveFirebase   = null;
    estadoAtual.motivoNaoAgendamento = null;
    motivoSelecionado = '';
    estadoAtual.entradaManualAtiva = false;
    estadoAtual.statusSincronizado = true;
    atualizarWidget();
    return;
  }

  // Novo contato detectado
  estadoAtual.numeroFormatado = contato.numeroFormatado;
  estadoAtual.nomeContato     = contato.nome;
  estadoAtual.numeroExibido   = contato.numeroRaw;
  estadoAtual.iaPausada       = false;
  estadoAtual.chaveFirebase   = null;
  estadoAtual.motivoNaoAgendamento = null;
  motivoSelecionado = '';
  estadoAtual.entradaManualAtiva = false;
  estadoAtual.statusSincronizado = false;

  await verificarStatusNoFirebase(contato.numeroFormatado);
}

// ──────────────────────────────────────────────
// MutationObserver — detecta mudanças no DOM
// ──────────────────────────────────────────────

function iniciarObservador() {
  if (observerDOM) observerDOM.disconnect();

  observerDOM = new MutationObserver(() => {
    // Debounce: espera 600ms de estabilidade antes de re-verificar
    agendarLeituraContato(600);
  });

  // Observa o elemento principal do WhatsApp Web
  const alvo = document.getElementById('main') || document.body;
  observerDOM.observe(alvo, {
    childList   : true,
    subtree     : true,
    attributes  : false,
    characterData: false,
  });
}

// Monitora mudanças na URL (ao trocar de conversa via clique na lista)
let urlAnterior = window.location.href;
setInterval(() => {
  if (window.location.href !== urlAnterior) {
    urlAnterior = window.location.href;
    estadoAtual.numeroManual = null; // reseta o manual ao trocar de aba via URL
    estadoAtual.entradaManualAtiva = false;
    estadoAtual.statusSincronizado = false;
    agendarLeituraContato(400);
  }
}, 500);

function iniciarLeituraAutomatica() {
  if (intervaloLeituraAutomatica) {
    clearInterval(intervaloLeituraAutomatica);
  }

  intervaloLeituraAutomatica = setInterval(() => {
    if (precisaSincronizarContato()) {
      agendarLeituraContato(120);
    }
  }, 1200);
}

// ──────────────────────────────────────────────
// Inicialização
// ──────────────────────────────────────────────

function inicializar() {
  criarWidget();
  iniciarObservador();
  iniciarLeituraAutomatica();
  // Primeira verificação após 1.5s (dá tempo do WhatsApp carregar)
  agendarLeituraContato(1500);
}

// Aguarda o WhatsApp Web estar completamente carregado
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializar);
} else {
  inicializar();
}

// Reobserva se o elemento #main for criado depois
const aguardarMain = new MutationObserver(() => {
  if (document.getElementById('main')) {
    iniciarObservador();
    aguardarMain.disconnect();
  }
});
aguardarMain.observe(document.body, { childList: true, subtree: true });

// ──────────────────────────────────────────────
// Listener de mensagens do Popup
// ──────────────────────────────────────────────
// O popup.js envia mensagens via chrome.tabs.sendMessage
// e aguarda resposta com o estado atualizado.

chrome.runtime.onMessage.addListener((mensagem, _sender, sendResponse) => {
  switch (mensagem.action) {

    // ── GET_STATUS: retorna o estado atual ──
    case 'GET_STATUS':
      sendResponse({ estado: { ...estadoAtual } });
      break;

    // ── PAUSAR_IA: pausa a IA para o contato atual ──
    case 'PAUSAR_IA':
      if (!estadoAtual.numeroFormatado) {
        sendResponse({ sucesso: false, erro: 'Nenhum contato detectado.' });
        break;
      }
      (async () => {
        try {
          const descricao = 'Pausado via Extensão';
          const chave = await fbAdicionarCancelado(
            descricao,
            estadoAtual.numeroFormatado,
            estadoAtual.entradaManualAtiva ? estadoAtual.nomeContato : null
          );
          estadoAtual.chaveFirebase = chave;
          estadoAtual.iaPausada     = true;
          animarControle('pausada');
          if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
            await recarregarListaBloqueados();
          }
          atualizarWidget();
          mostrarToast('🔴 IA pausada para este paciente');
          sendResponse({ sucesso: true, estado: { ...estadoAtual } });
        } catch (erro) {
          console.error('[Pausa IA] Erro ao pausar:', erro);
          sendResponse({ sucesso: false, erro: 'Erro ao gravar no Firebase: ' + erro.message });
        }
      })();
      return true; // mantém canal aberto para resposta assíncrona

    // ── REATIVAR_IA: remove do Firebase e reativa ──
    case 'REATIVAR_IA':
      if (!estadoAtual.numeroFormatado) {
        sendResponse({ sucesso: false, erro: 'Nenhum contato detectado.' });
        break;
      }
      (async () => {
        try {
          let chave = estadoAtual.chaveFirebase;
          if (!chave) {
            chave = await fbBuscarChavePorTelefone(estadoAtual.numeroFormatado);
          }
          if (chave) {
            await fbRemoverCancelado(chave);
          }
          estadoAtual.chaveFirebase = null;
          estadoAtual.iaPausada     = false;
          animarControle('ativa');
          if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
            await recarregarListaBloqueados();
          }
          atualizarWidget();
          mostrarToast('🟢 IA reativada para este paciente');
          sendResponse({ sucesso: true, estado: { ...estadoAtual } });
        } catch (erro) {
          console.error('[Pausa IA] Erro ao reativar:', erro);
          sendResponse({ sucesso: false, erro: 'Erro ao remover do Firebase: ' + erro.message });
        }
      })();
      return true; // mantém canal aberto para resposta assíncrona

    default:
      sendResponse({ sucesso: false, erro: 'Ação desconhecida: ' + mensagem.action });
  }
});
