# 🏗️ DIAGRAMA VISUAL - SISTEMA DE SALAS ONLINE

## Arquitetura Geral

```
┌──────────────────────────────────────────────────────────────────────┐
│                         NAVEGADOR (Client)                           │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    index.html                                  │  │
│  │  ┌──────────────────────────────────────────────────────────┐ │  │
│  │  │              Canvas do Jogo                             │ │  │
│  │  │                                                          │ │  │
│  │  │         (gameClient.js rodando)                         │ │  │
│  │  └──────────────────────────────────────────────────────────┘ │  │
│  │                                                                 │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │           MODAL DE SALAS (roomUI.js)                   │  │  │
│  │  │  ┌─────────────────────────────────────────────────┐   │  │  │
│  │  │  │ Aba 1: Entrar em Sala                          │   │  │  │
│  │  │  │ ├─ Campo de código                            │   │  │  │
│  │  │  │ ├─ Campo de senha (privada)                   │   │  │  │
│  │  │  │ └─ Lista de salas públicas                    │   │  │  │
│  │  │  ├─ Aba 2: Criar Sala                            │   │  │  │
│  │  │  │ ├─ Nome da sala                               │   │  │  │
│  │  │  │ ├─ Tipo (pública/privada)                     │   │  │  │
│  │  │  │ ├─ Senha (se privada)                         │   │  │  │
│  │  │  │ ├─ Raio do mapa (slider)                      │   │  │  │
│  │  │  │ ├─ Raio da base (slider)                      │   │  │  │
│  │  │  │ ├─ Velocidade (slider)                        │   │  │  │
│  │  │  │ └─ Max jogadores                              │   │  │  │
│  │  │  └─ Aba 3: Minha Sala                            │   │  │  │
│  │  │    ├─ Código (com botão copiar)                  │   │  │  │
│  │  │    ├─ Tipo                                        │   │  │  │
│  │  │    ├─ Jogadores conectados                        │   │  │  │
│  │  │    ├─ Configurações                              │   │  │  │
│  │  │    ├─ Botão: Sair                                │   │  │  │
│  │  │    └─ Botão: Fechar (se criador)                │   │  │  │
│  │  └─────────────────────────────────────────────────────┘   │  │
│  │                                                                 │  │
│  │  ATALHOS:                                                      │  │
│  │  • R = Abrir/Fechar Modal                                     │  │
│  │  • T = Entrar em Sala de Teste (TESTE123)                    │  │
│  │                                                                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │         GERENCIADOR DE ESPECTADOR (spectatorManager.js)       │   │
│  │         (Observar partidas ao fundo)                          │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│                            Socket.IO                                  │
│                         ↓ Emitir eventos                             │
│                         ↑ Receber eventos                             │
│                                                                        │
└────────────────────────────────┬─────────────────────────────────────┘
                                  │
                                  │
┌─────────────────────────────────▼─────────────────────────────────────┐
│                    SERVIDOR (Node.js / server.js)                      │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │             Socket.IO Server (io)                             │    │
│  │  ┌────────────────────────────────────────────────────────┐   │    │
│  │  │  roomSocketHandler.js                                 │   │    │
│  │  │  (Registra todos os eventos de sala)                 │   │    │
│  │  │                                                        │   │    │
│  │  │  Eventos:                                            │   │    │
│  │  │  • criar_sala                                         │   │    │
│  │  │  • entrar_sala                                        │   │    │
│  │  │  • sair_sala                                          │   │    │
│  │  │  • fechar_sala                                        │   │    │
│  │  │  • listar_salas_publicas                             │   │    │
│  │  │  • buscar_sala                                        │   │    │
│  │  │  • entrar_como_espectador                            │   │    │
│  │  │  • parar_espectador                                   │   │    │
│  │  └────────────────────────────────────────────────────────┘   │    │
│  └───────────────────────────┬──────────────────────────────────┘    │
│                              │                                        │
│                              │                                        │
│  ┌───────────────────────────▼──────────────────────────────────┐    │
│  │         roomSystem.js (Gerenciador de Salas)                │    │
│  │  ┌────────────────────────────────────────────────────────┐  │    │
│  │  │ Map<código, Sala>  (Dados em Memória)                 │  │    │
│  │  │                                                         │  │    │
│  │  │ ABCD12: {                                             │  │    │
│  │  │   codigo: "ABCD12",                                   │  │    │
│  │  │   nome: "Minha Sala",                                 │  │    │
│  │  │   tipo: "publica",                                    │  │    │
│  │  │   criador: "socket-xxx",                              │  │    │
│  │  │   jogadores: Set[socket1, socket2, ...],             │  │    │
│  │  │   configuracoes: {                                    │  │    │
│  │  │     raioMapa: 1500,                                   │  │    │
│  │  │     raioBase: 200,                                    │  │    │
│  │  │     velocidade: 600,                                  │  │    │
│  │  │     maxJogadores: 10                                  │  │    │
│  │  │   },                                                  │  │    │
│  │  │   dataCriacao: Date                                  │  │    │
│  │  │ },                                                    │  │    │
│  │  │                                                        │  │    │
│  │  │ EFGH34: {...},                                        │  │    │
│  │  │ IJKL56: {...}                                         │  │    │
│  │  │ ...                                                    │  │    │
│  │  └────────────────────────────────────────────────────────┘  │    │
│  │                                                                 │    │
│  │  Funções:                                                      │    │
│  │  • criarSala()                                                 │    │
│  │  • entrarSala()                                                │    │
│  │  • sairSala()                                                  │    │
│  │  • fecharSala()                                                │    │
│  │  • buscarSala()                                                │    │
│  │  • obterSalaDoJogador()                                        │    │
│  │  • listarSalasPublicas()                                       │    │
│  │  • obterEstatisticas()                                         │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │  Players Map (existente)                                      │    │
│  │  - Dados dos jogadores conectados                            │    │
│  │  - Sincronizado com system de salas                          │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Fluxo de Dados - Criar Sala

```
┌─────────────────────────────────────────────────────────────────┐
│ USUÁRIO PRESSIONA: R → Clica "Criar Sala" → Preenche dados     │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Validar inputs     │
              │ (client-side)        │
              └──────┬───────────────┘
                     │ Se válido
                     ▼
    ┌─────────────────────────────────────┐
    │ socket.emit('criar_sala', {        │
    │   nome,                            │
    │   tipo,                            │
    │   senha,                           │
    │   configuracoes                    │
    │ })                                 │
    └────────┬────────────────────────────┘
             │
        Socket.IO
             │
             ▼
    ┌─────────────────────────────────────┐
    │ roomSocketHandler.js                │
    │ (server-side)                       │
    └────────┬────────────────────────────┘
             │
             ▼
    ┌─────────────────────────────────────┐
    │ roomSystem.criarSala(dados)         │
    │                                     │
    │ 1. Validar dados                   │
    │ 2. Gerar código único              │
    │ 3. Criar objeto Sala               │
    │ 4. Adicionar a Map                 │
    │ 5. Retornar sucesso                │
    └────────┬────────────────────────────┘
             │
             ▼
    ┌─────────────────────────────────────┐
    │ socket.emit('sala_criada', {       │
    │   codigo,                          │
    │   sala                             │
    │ })                                 │
    └────────┬────────────────────────────┘
             │
        Socket.IO
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Callback recebe resposta e mostra mensagem "Sala criada"        │
│ Modal atualiza para aba "Minha Sala"                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Fluxo de Dados - Entrar em Sala

```
┌───────────────────────────────────────────────────────────────┐
│ USUÁRIO: R → "Entrar em Sala" → Digita código → Clica Entrar │
└─────────────────────┬──────────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │  Validar código        │
         │  (client-side)         │
         └────────┬───────────────┘
                  │ Se válido
                  ▼
    ┌──────────────────────────────────────┐
    │ socket.emit('entrar_sala', {        │
    │   codigo,                           │
    │   senha                             │
    │ })                                  │
    └─────────┬───────────────────────────┘
              │
         Socket.IO
              │
              ▼
    ┌──────────────────────────────────────┐
    │ roomSocketHandler.js                 │
    │ (server-side)                        │
    └─────────┬───────────────────────────┘
              │
              ▼
    ┌──────────────────────────────────────┐
    │ sistemaRooms.entrarSala()            │
    │                                      │
    │ 1. Procurar sala (Map)              │
    │ 2. Validar senha                    │
    │ 3. Validar não está cheia           │
    │ 4. Adicionar jogador                │
    │ 5. Retornar sucesso                 │
    └─────────┬───────────────────────────┘
              │
              ▼
    ┌──────────────────────────────────────┐
    │ socket.emit('jogador_entrou')        │
    │ para todos na sala                   │
    │                                      │
    │ io.emit('salas_atualizadas')         │
    │ para broadcast global                │
    └─────────┬───────────────────────────┘
              │
         Socket.IO
              │
              ▼
┌───────────────────────────────────────────────────────────────┐
│ Callback: Mostra "Entrou na sala"                             │
│ Modal: Muda para aba "Minha Sala" com dados atualizados       │
│ Outras abas: Recebem "salas_atualizadas" e atualizam lista   │
└───────────────────────────────────────────────────────────────┘
```

---

## Estrutura de Dados em Memória

```
┌─────────────────────────────────────────────────────────────────┐
│ sistemaRooms.salas (Map)                                        │
│                                                                  │
│ ABCD12 → ┌──────────────────────────────────────────────┐      │
│          │ Sala {                                        │      │
│          │   codigo: "ABCD12"                           │      │
│          │   nome: "Sala Principal"                     │      │
│          │   tipo: "publica"                            │      │
│          │   senha: null                                │      │
│          │   criador: "socket-uuid-1"                   │      │
│          │   jogadores: Set{                            │      │
│          │     "socket-uuid-1",                        │      │
│          │     "socket-uuid-2",                        │      │
│          │     "socket-uuid-3"                         │      │
│          │   }                                           │      │
│          │   configuracoes: {                           │      │
│          │     raioMapa: 1500,                          │      │
│          │     raioBase: 200,                           │      │
│          │     velocidade: 600,                         │      │
│          │     maxJogadores: 10                         │      │
│          │   }                                           │      │
│          │   dataCriacao: Date                          │      │
│          │ }                                             │      │
│          └──────────────────────────────────────────────┘      │
│                                                                  │
│ EFGH34 → ┌──────────────────────────────────────────────┐      │
│          │ Sala {                                        │      │
│          │   codigo: "EFGH34"                           │      │
│          │   nome: "Sala Privada"                       │      │
│          │   tipo: "privada"                            │      │
│          │   senha: "senha123"                          │      │
│          │   criador: "socket-uuid-4"                   │      │
│          │   jogadores: Set{                            │      │
│          │     "socket-uuid-4",                        │      │
│          │     "socket-uuid-5"                         │      │
│          │   }                                           │      │
│          │   configuracoes: {...}                       │      │
│          │   dataCriacao: Date                          │      │
│          │ }                                             │      │
│          └──────────────────────────────────────────────┘      │
│                                                                  │
│ TESTE123 → ┌──────────────────────────────────────────┐        │
│            │ Sala { (Sala de Teste Automática)        │        │
│            │   codigo: "TESTE123"                     │        │
│            │   nome: "Sala de Teste"                  │        │
│            │   tipo: "privada"                        │        │
│            │   senha: "teste"                         │        │
│            │   criador: "sistema"                     │        │
│            │   jogadores: Set{...}                    │        │
│            │   ...                                    │        │
│            │ }                                         │        │
│            └──────────────────────────────────────────┘        │
│                                                                  │
│ ... (outras salas)                                             │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ sistemaRooms.jogadorParaSala (Map)                               │
│                                                                   │
│ socket-uuid-1 → "ABCD12"                                         │
│ socket-uuid-2 → "ABCD12"                                         │
│ socket-uuid-3 → "ABCD12"                                         │
│ socket-uuid-4 → "EFGH34"                                         │
│ socket-uuid-5 → "EFGH34"                                         │
│ socket-uuid-6 → "TESTE123"                                       │
│ ... (rápida lookup: qual sala um jogador está?)                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Validações em Cascata

```
CLIENTE (Rápido)
  ├─ Código de sala está preenchido?
  ├─ Senha está preenchida? (se privada)
  ├─ Nome da sala tem 1-50 caracteres?
  ├─ Configurações estão em ranges válidos?
  └─ Se OK → Envia para servidor

SERVIDOR (Seguro)
  ├─ Sala existe?
  ├─ Sala não está cheia?
  ├─ Senha está correta? (se privada)
  ├─ Configurações são válidas?
  ├─ Jogador já está na sala?
  └─ Se OK → Processa e retorna sucesso
```

---

## Eventos em Tempo Real

```
┌──────────────────────────────────────────────────┐
│  CLIENTE A (Aba 1)                              │
│  Cria sala ABCD12                               │
└────────────┬─────────────────────────────────────┘
             │ socket.emit('criar_sala', {...})
             │
        ┌────▼────────────────────────────────┐
        │   Socket.IO Server (broadcast)      │
        └────┬─────────┬──────────┬────────────┘
             │         │          │
    ┌────────▼──┐    ┌─▼────────┐ └──────┬──────┐
    │ CLIENTE A  │    │ CLIENTE B│        │ ... │
    │ (callback) │    │(recebe)  │        │     │
    └────────────┘    │          │        │     │
                      └──────────┘        │     │
                                          │     │
                   ┌──────────────────────▼─────▼┐
                   │ CLIENTE B (Aba 2)           │
                   │ Vê nova sala em lista       │
                   │ socket.on('salas_atualizadas')
                   └─────────────────────────────┘
```

---

## Estados do Sistema

```
┌─────────────────────────────────────────────┐
│           CICLO DE VIDA DE SALA             │
└─────────────────────────────────────────────┘

1. CRIAÇÃO
   socket.emit('criar_sala') 
   → Validar 
   → Gerar código 
   → Adicionar a Map
   → ✓ ATIVA (com 1 jogador: criador)

2. CRESCIMENTO
   Múltiplos socket.emit('entrar_sala')
   → Validar 
   → Adicionar a Set de jogadores
   → Atualizar contador
   → ✓ ATIVA (com N jogadores)

3. REDUÇÃO
   socket.emit('sair_sala')
   → Remover de Set de jogadores
   → Atualizar contador
   → Se jogadores.size === 0: ir para 4
   → ✓ ATIVA (com N-1 jogadores)

4. LIMPEZA
   Último jogador saiu
   → Remover da Map
   → Remover do jogadorParaSala
   → ✗ DELETADA
```

---

## Responsividade - Layout em Diferentes Tamanhos

```
┌─────────────────────────────────────────────┐
│           DESKTOP (1920x1080)               │
│ ┌───────────────────────────────────────┐   │
│ │ Modal (800px wide)                    │   │
│ │ ┌─────────────────────────────────┐   │   │
│ │ │ Header                          │   │   │
│ │ ├─────────────────────────────────┤   │   │
│ │ │ Abas                            │   │   │
│ │ ├─────────────────────────────────┤   │   │
│ │ │ Content (3 colunas se possível) │   │   │
│ │ │ Botões lado a lado              │   │   │
│ │ └─────────────────────────────────┘   │   │
│ └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│           TABLET (768x1024)                 │
│ ┌───────────────────────────────────────┐   │
│ │ Modal (90% width, máx 800px)          │   │
│ │ ┌─────────────────────────────────┐   │   │
│ │ │ Header (font menor)             │   │   │
│ │ ├─────────────────────────────────┤   │   │
│ │ │ Abas (stacked)                  │   │   │
│ │ ├─────────────────────────────────┤   │   │
│ │ │ Content (2 colunas)             │   │   │
│ │ │ Botões em linha                 │   │   │
│ │ └─────────────────────────────────┘   │   │
│ └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│           MOBILE (375x667)                  │
│ ┌─────────────────────────────────────┐     │
│ │ Modal (95% width)                   │     │
│ │ ┌───────────────────────────────┐   │     │
│ │ │ Header (font X-small)         │   │     │
│ │ ├───────────────────────────────┤   │     │
│ │ │ Abas (vertical scroll)        │   │     │
│ │ ├───────────────────────────────┤   │     │
│ │ │ Content (1 coluna)            │   │     │
│ │ │ Inputs em coluna              │   │     │
│ │ │ Botões 100% width vertical    │   │     │
│ │ │ Lista com scroll vertical     │   │     │
│ │ └───────────────────────────────┘   │     │
│ └─────────────────────────────────────┘     │
└─────────────────────────────────────────────┘
```

---

## Segurança - Camadas de Validação

```
┌─────────────────────────────────────┐
│  USUÁRIO digita dados               │
└────────────┬────────────────────────┘
             │
             ▼
    ┌────────────────────┐
    │ VALIDAÇÃO CLIENT   │ (Rápida, UX)
    │ • Tipo de dados    │
    │ • Comprimento      │
    │ • Range de valores │
    │ • Campos vazios     │
    └────────┬───────────┘
             │ Se OK
             ▼
   ┌──────────────────────┐
   │ ENVIO Socket.IO      │
   │ • Rate limiting      │
   │ • Proteção CSRF      │
   └────────┬─────────────┘
            │
            ▼
   ┌──────────────────────┐
   │ VALIDAÇÃO SERVER     │ (Segura)
   │ • Revalidar tipo     │
   │ • Revalidar range    │
   │ • Revalidar existência
   │ • Revalidar permissões
   │ • Log de auditoria   │
   └────────┬─────────────┘
            │ Se OK
            ▼
   ┌──────────────────────┐
   │ PROCESSAMENTO        │
   │ • Atualizar dados    │
   │ • Sincronizar estado │
   │ • Notificar clientes │
   └────────┬─────────────┘
            │
            ▼
   ┌──────────────────────┐
   │ RESPOSTA            │
   │ • Confirmação       │
   │ • Dados atualizados │
   └──────────────────────┘
```

---

**Diagrama criado em 2026-06-10 | Sistema de Salas Online v1.0 ✅**
