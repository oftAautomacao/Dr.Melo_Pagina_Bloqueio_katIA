# 🤖 Pausa IA — Extensão Chrome para WhatsApp Web

> Controle a IA de atendimento do Dr. Melo diretamente pelo WhatsApp Web.
> Pause ou retome respostas automáticas para qualquer paciente com **um único clique**.

---

## 📁 Estrutura de Arquivos

```
AbaCancelar_DrMelo/
├── manifest.json        → Configuração da extensão (Manifest V3)
├── content.js           → Script injetado no WhatsApp Web
├── content.css          → Estilo do widget flutuante
├── firebase-config.js   → (referência — configuração embutida no content.js)
├── popup.html           → Interface do popup da extensão
├── popup.js             → Lógica do popup
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Como Instalar

1. Abra o Google Chrome
2. Acesse: **`chrome://extensions/`**
3. Ative o **"Modo do desenvolvedor"** (canto superior direito)
4. Clique em **"Carregar sem compactação"**
5. Selecione esta pasta: `AbaCancelar_DrMelo/`
6. A extensão aparecerá na barra do Chrome ✅

---

## 🔧 Como Usar

### Widget flutuante (dentro do WhatsApp Web)
1. Abra o **WhatsApp Web** (`web.whatsapp.com`)
2. Clique em qualquer conversa com um paciente
3. O widget **🤖 IA do Paciente** aparecerá no canto inferior direito
4. Clique no **toggle** para pausar ou reativar a IA

### Popup da extensão (ícone na barra do Chrome)
1. Clique no ícone 🤖 na barra de extensões do Chrome
2. O popup mostrará o contato atual e o status da IA
3. Clique no botão **Pausar IA** ou **Reativar IA**

---

## 🔄 Comportamento

| Estado do Toggle | Cor     | O que acontece                              |
|-----------------|---------|---------------------------------------------|
| **Desligado**   | 🟢 Verde  | IA ativa — responde normalmente             |
| **Ligado**      | 🔴 Vermelho | IA pausada — sem resposta automática     |

- Ao **pausar**: grava `{ descricao, telefone }` no Firebase → IA para de responder
- Ao **reativar**: remove o item do Firebase → IA volta a responder
- Ao **trocar de conversa**: o widget atualiza automaticamente o status

---

## 🔥 Firebase

| Campo            | Valor                                                   |
|------------------|---------------------------------------------------------|
| **Database URL** | `https://oftautomacao-9b427-default-rtdb.firebaseio.com` |
| **Nó**           | `/DRM/agendamentoWhatsApp/configuracoes/cancelados`     |
| **Formato Tel.** | `5521977164257` (somente dígitos, sem `+`, espaços, `-`) |

### Estrutura gravada no Firebase ao pausar:
```json
{
  "-NxABC123": {
    "descricao": "João Silva — Pausado via Extensão",
    "telefone":  "5521977164257"
  }
}
```

---

## ⚠️ Detecção do Número

O `content.js` tenta detectar o número do contato usando **4 estratégias em cascata**:

1. **Seletores DOM** do painel de informações do WhatsApp Web
2. **Varredura de texto** com regex de telefone brasileiro (`+55 XX XXXXX-XXXX`)
3. **URL** com parâmetro `?phone=...`
4. **Hash da URL** com formato `#/5521...@s.whatsapp.net`

> ⚠️ O WhatsApp Web atualiza sua interface frequentemente. Se o número não for detectado automaticamente, abra o **painel de informações do contato** (clique no nome do contato no topo da conversa) — isso exporá o número no DOM.

---

## 🛠️ Resolução de Problemas

| Problema | Solução |
|----------|---------|
| Widget não aparece | Recarregue o WhatsApp Web (F5) |
| Número não detectado | Abra o painel de info do contato (clique no nome) |
| Erro de Firebase | Verifique as regras de segurança do Realtime Database |
| Popup diz "WhatsApp Web não aberto" | Abra `web.whatsapp.com` em uma aba |
| Extensão desatualizada | Vá em `chrome://extensions/` e clique no ícone de recarregar |

---

## 🔐 Regras do Firebase (Realtime Database)

Para que a extensão funcione **sem autenticação**, as regras devem permitir leitura e escrita no nó `/DRM`:

```json
{
  "rules": {
    "DRM": {
      ".read": true,
      ".write": true
    }
  }
}
```

> Se as regras exigirem autenticação, será necessário adicionar um token de acesso à extensão.

---

## 📋 Histórico de Versões

| Versão | Data       | Mudanças                      |
|--------|------------|-------------------------------|
| 1.0.0  | Jun/2026   | Versão inicial — widget + popup + Firebase REST API |

---

*Projeto: Extensão Chrome — Pausa IA WhatsApp Web | Dr. Melo Oftalmologia*
