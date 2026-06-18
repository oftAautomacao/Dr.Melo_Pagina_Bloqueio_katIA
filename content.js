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

// ──────────────────────────────────────────────
// Estado global do widget
// ──────────────────────────────────────────────
let estadoAtual = {
  numeroFormatado : null,   // ex: "5521977164257"
  nomeContato     : null,   // ex: "João Silva"
  numeroExibido   : null,   // ex: "+55 21 97716-4257"
  iaPausada       : false,
  chaveFirebase   : null,   // chave do item no Firebase (para deletar)
  carregando      : false,
  numeroManual    : null,   // Guarda o número inserido manualmente
};

estadoAtual.entradaManualAtiva = false;

let observerDOM = null;
let timerDebounce = null;
let painelBloqueadosEl = null;
let recarregarListaBloqueados = async () => {};

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

/** Adiciona um novo cancelado (usando o próprio número como chave via PUT) */
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
      <span id="pausa-ia-icon">🤖</span>
      <span id="pausa-ia-title">IA</span>
      <div class="pausa-ia-divider"></div>
      <span id="pausa-ia-numero" title="Clique para inserir manualmente">—</span>
      <input type="text" id="pausa-ia-input-manual" placeholder="Cole o telefone" maxlength="20" />
      <div class="pausa-ia-divider"></div>
      <button id="btn-recarregar" title="Forçar recarregamento">↻</button>
      <button id="btn-bloqueados" title="Mostrar bloqueados">▾</button>
      <label id="pausa-ia-switch" title="Pausar / retomar IA">
        <input type="checkbox" id="pausa-ia-checkbox" />
        <span id="pausa-ia-slider"></span>
      </label>
    </div>
    <div id="pausa-ia-bloqueados" hidden>
      <div class="pausa-ia-bloqueados-header">Bloqueados atuais</div>
      <div id="pausa-ia-bloqueados-lista"></div>
    </div>
  `;

  document.body.appendChild(widget);

  // Evento de clique no toggle
  document.getElementById('pausa-ia-checkbox').addEventListener('change', aoClicarToggle);

  // Evento Recarregar
  document.getElementById('btn-recarregar').addEventListener('click', async (e) => {
    e.stopPropagation();
    const icon = e.target;
    icon.classList.add('spin-anim');
    setTimeout(() => icon.classList.remove('spin-anim'), 500);
    
    // Força re-verificação limpando o estado atual
    estadoAtual.numeroFormatado = null; 
    await aoMudarConversa();
    mostrarToast('Página lida novamente!');
  });

  const painelBloqueados = document.getElementById('pausa-ia-bloqueados');
  const listaBloqueados = document.getElementById('pausa-ia-bloqueados-lista');
  const btnBloqueados = document.getElementById('btn-bloqueados');
  painelBloqueadosEl = painelBloqueados;

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
      widget.classList.add('lista-bloqueados-aberta');
      btnBloqueados.textContent = '▴';
      await carregarBloqueados();
    } else {
      painelBloqueados.setAttribute('hidden', '');
      widget.classList.remove('lista-bloqueados-aberta');
      btnBloqueados.textContent = '▾';
    }
  });

  // Lógica de Entrada Manual
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
      e.target.closest('#btn-recarregar') ||
      e.target.closest('#btn-bloqueados') ||
      e.target.closest('#pausa-ia-switch') ||
      e.target.closest('#pausa-ia-input-manual') ||
      e.target.closest('#pausa-ia-bloqueados')
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
  const elCheck  = document.getElementById('pausa-ia-checkbox');
  if (!widget) return;

  // Remove todas as classes de estado
  widget.classList.remove('ia-ativa', 'ia-pausada', 'sem-contato', 'carregando');

  if (estadoAtual.carregando) {
    widget.classList.add('carregando');
    elNumero.textContent = 'Buscando...';
    return;
  }

  if (!estadoAtual.numeroFormatado) {
    widget.classList.add('sem-contato');
    elNumero.textContent = 'Sem contato';
    elCheck.checked = false;
    return;
  }

  elNumero.textContent = estadoAtual.numeroExibido || estadoAtual.numeroFormatado;

  if (estadoAtual.iaPausada) {
    widget.classList.add('ia-pausada');
    elCheck.checked = true;
  } else {
    widget.classList.add('ia-ativa');
    elCheck.checked = false;
  }
}

function mostrarToast(mensagem, duracao = 2500) {
  const toast = document.getElementById('pausa-ia-toast');
  if (!toast) return;
  toast.textContent = mensagem;
  toast.classList.add('visivel');
  setTimeout(() => toast.classList.remove('visivel'), duracao);
}

function animarRobo(tipo) {
  const robo = document.getElementById('pausa-ia-icon');
  if (!robo) return;

  const classe = tipo === 'pausada' ? 'animar-pausada' : 'animar-ativa';
  robo.classList.remove('animar-ativa', 'animar-pausada');

  // Reinicia a animação mesmo em cliques consecutivos.
  void robo.offsetWidth;
  robo.classList.add(classe);

  setTimeout(() => {
    robo.classList.remove(classe);
  }, 900);
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
    animarRobo('pausada');
    if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
      await recarregarListaBloqueados();
    }
    mostrarToast('🔴 IA pausada para este paciente');
  } catch (erro) {
    console.error('[Pausa IA] Erro ao salvar nÃºmero manual:', erro);
    estadoAtual.iaPausada = false;
    estadoAtual.chaveFirebase = null;
    mostrarToast('❌ Erro ao salvar no Firebase');
  } finally {
    estadoAtual.carregando = false;
    atualizarWidget();
  }
}

async function aoClicarToggle(event) {
  // Impede ação se não houver contato detectado
  if (!estadoAtual.numeroFormatado) {
    event.target.checked = false;
    mostrarToast('⚠️ Nenhum contato detectado');
    return;
  }

  const querPausar = event.target.checked; // true = pausar, false = reativar

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
      animarRobo('pausada');
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
      animarRobo('ativa');
      if (painelBloqueadosEl && !painelBloqueadosEl.hasAttribute('hidden')) {
        await recarregarListaBloqueados();
      }
      mostrarToast('🟢 IA reativada para este paciente');
    }
  } catch (erro) {
    console.error('[Pausa IA] Erro ao comunicar com Firebase:', erro);
    mostrarToast('❌ Erro ao conectar com Firebase');
    // Reverte o estado visual do toggle
    event.target.checked = !querPausar;
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
    const chave = await fbBuscarChavePorTelefone(numero);
    estadoAtual.iaPausada     = chave !== null;
    estadoAtual.chaveFirebase = chave;
  } catch (erro) {
    console.error('[Pausa IA] Erro ao verificar Firebase:', erro);
    estadoAtual.iaPausada     = false;
    estadoAtual.chaveFirebase = null;
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
  if (contato && contato.numeroFormatado === estadoAtual.numeroFormatado) return;

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
          atualizarWidget();
          return;
        }
      } catch (erro) {
        console.error('[Pausa IA] Erro ao buscar vínculo por nome:', erro);
      }
    }

    estadoAtual.numeroFormatado = null;
    estadoAtual.nomeContato     = nomeVisivel;
    estadoAtual.numeroExibido   = null;
    estadoAtual.iaPausada       = false;
    estadoAtual.chaveFirebase   = null;
    estadoAtual.entradaManualAtiva = false;
    atualizarWidget();
    return;
  }

  // Novo contato detectado
  estadoAtual.numeroFormatado = contato.numeroFormatado;
  estadoAtual.nomeContato     = contato.nome;
  estadoAtual.numeroExibido   = contato.numeroRaw;
  estadoAtual.iaPausada       = false;
  estadoAtual.chaveFirebase   = null;
  estadoAtual.entradaManualAtiva = false;

  await verificarStatusNoFirebase(contato.numeroFormatado);
}

// ──────────────────────────────────────────────
// MutationObserver — detecta mudanças no DOM
// ──────────────────────────────────────────────

function iniciarObservador() {
  if (observerDOM) observerDOM.disconnect();

  observerDOM = new MutationObserver(() => {
    // Debounce: espera 600ms de estabilidade antes de re-verificar
    clearTimeout(timerDebounce);
    timerDebounce = setTimeout(aoMudarConversa, 600);
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
    clearTimeout(timerDebounce);
    timerDebounce = setTimeout(aoMudarConversa, 400);
  }
}, 500);

// ──────────────────────────────────────────────
// Inicialização
// ──────────────────────────────────────────────

function inicializar() {
  criarWidget();
  iniciarObservador();
  // Primeira verificação após 1.5s (dá tempo do WhatsApp carregar)
  setTimeout(aoMudarConversa, 1500);
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
          animarRobo('pausada');
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
          animarRobo('ativa');
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
