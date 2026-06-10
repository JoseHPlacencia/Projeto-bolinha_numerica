# 📚 SISTEMA DE SALAS ONLINE - GUIA DE INTEGRAÇÃO

## ✅ Integração Realizada

O módulo de "Sistema de Salas Online" foi **completamente integrado** ao seu projeto. Aqui está o que foi feito:

---

## 📁 Arquivos Criados

### Backend (Node.js)
```
src/
├── systems/
│   └── roomSystem.js          # ⭐ Sistema de gerenciamento de salas
├── core/
│   └── roomSocketHandler.js   # ⭐ Eventos Socket.IO das salas
└── config/
    └── gameConfig.js          # (modificado) Adicionado config de salas
```

### Frontend (Browser)
```
public/
├── js/
│   ├── ui/
│   │   ├── roomUI.js          # ⭐ Interface modal de salas
│   │   └── spectatorManager.js # ⭐ Gerenciador de espectador
│   └── gameClient.js          # (modificado) Integração do sistema
├── css/
│   └── roomModal.css          # ⭐ Estilos do modal
└── index.html                 # (modificado) Link ao CSS
```

---

## 🚀 Como Usar

### 1️⃣ Abrir Gerenciador de Salas
**Tecla: R**
- Abre/Fecha um modal com interface completa de salas
- Permite criar novas salas
- Permite entrar em salas existentes
- Mostra lista de salas públicas
- Exibe informações da sala atual

### 2️⃣ Criar Uma Sala
1. Pressione **R** para abrir o modal
2. Vá para a aba "Criar Sala"
3. Configure:
   - **Nome da Sala**: Nome exibido
   - **Tipo**: Pública ou Privada
   - **Senha**: (apenas se privada)
   - **Raio do Mapa**: 500px a 5000px
   - **Raio da Base**: 50px a 500px
   - **Velocidade**: 100px/s a 1000px/s
   - **Máximo de Jogadores**: 2 a 50
4. Clique em "Criar Sala"
5. Seu código único será gerado automaticamente

### 3️⃣ Entrar em Uma Sala
**Opção A: Por Código**
1. Pressione **R** para abrir o modal
2. Na aba "Entrar em Sala", digite o código (ex: ABCD12)
3. Se privada, digite a senha
4. Clique em "Entrar"

**Opção B: Da Lista**
1. Pressione **R**
2. Na aba "Entrar em Sala", clique "Atualizar Lista"
3. Selecione uma sala da lista
4. Clique em "Entrar"

### 4️⃣ Sala de Teste Rápida
**Tecla: T**
- Entra automaticamente em uma sala de teste
- Se não existir, cria automaticamente
- Código: `TESTE123`
- Senha: `teste`
- Ideal para testes rápidos

### 5️⃣ Informações da Sua Sala
1. Pressione **R**
2. Vá para a aba "Minha Sala"
3. Veja:
   - Código (com botão de copiar)
   - Tipo (pública ou privada)
   - Número de jogadores
   - Configurações
   - Botão para sair
   - Botão para fechar (se for criador)

---

## 🔌 Eventos Socket.IO

### Cliente → Servidor

#### `criar_sala`
```javascript
socket.emit('criar_sala', {
    nome: 'Minha Sala',
    tipo: 'publica', // ou 'privada'
    senha: 'minhaSenha', // só se privada
    configuracoes: {
        raioMapa: 1500,
        raioBase: 200,
        velocidade: 600,
        maxJogadores: 10
    }
}, (resposta) => {
    if (resposta.sucesso) {
        console.log('Sala criada:', resposta.codigo);
    }
});
```

#### `entrar_sala`
```javascript
socket.emit('entrar_sala', {
    codigo: 'ABCD12',
    senha: 'minhaSenha' // opcional
}, (resposta) => {
    if (resposta.sucesso) {
        console.log('Entrou na sala');
    }
});
```

#### `sair_sala`
```javascript
socket.emit('sair_sala', (resposta) => {
    if (resposta.sucesso) {
        console.log('Saiu da sala');
    }
});
```

#### `fechar_sala`
```javascript
socket.emit('fechar_sala', 'ABCD12', (resposta) => {
    if (resposta.sucesso) {
        console.log('Sala fechada');
    }
});
```

#### `listar_salas_publicas`
```javascript
socket.emit('listar_salas_publicas', (resposta) => {
    console.log(resposta.salas);
});
```

#### `buscar_sala`
```javascript
socket.emit('buscar_sala', 'ABCD12', (resposta) => {
    if (resposta.sucesso) {
        console.log(resposta.sala);
    }
});
```

### Servidor → Cliente

#### `salas_atualizadas`
```javascript
socket.on('salas_atualizadas', (dados) => {
    console.log(dados.salasPublicas);
});
```

#### `sala_deletada`
```javascript
socket.on('sala_deletada', (dados) => {
    console.log('Sala deletada:', dados.codigo);
});
```

#### `jogador_entrou`
```javascript
socket.on('jogador_entrou', (dados) => {
    console.log('Novo jogador entrou');
    console.log('Total:', dados.jogadoresConectados);
});
```

---

## 🏗️ Estrutura de Dados - Sala

```javascript
{
    codigo: "ABCD12",           // Único, gerado automaticamente
    nome: "Minha Sala",         // Nome exibido
    tipo: "publica",            // 'publica' ou 'privada'
    criador: "socket-id-xxx",   // ID do socket do criador
    jogadoresConectados: 3,     // Número atual de jogadores
    configuracoes: {
        raioMapa: 1500,         // Raio do mapa
        raioBase: 200,          // Raio inicial da base
        velocidade: 600,        // Velocidade dos jogadores
        maxJogadores: 10        // Máximo de jogadores
    },
    dataCriacao: "2025-06-10T10:30:00.000Z"
}
```

---

## 📊 Gerenciamento de Salas no Backend

### Funções Disponíveis

```javascript
// Acessar o sistema:
const sistemaRooms = require('./systems/roomSystem').criarSistemaRooms(config.rooms);

// Criar sala
sistemaRooms.criarSala(dados, socketId);

// Entrar em sala
sistemaRooms.entrarSala(codigo, socketId, { senha });

// Sair de sala
sistemaRooms.sairSala(socketId);

// Fechar sala (apenas criador)
sistemaRooms.fecharSala(codigo, socketId);

// Buscar sala
sistemaRooms.buscarSala(codigo);

// Obter sala do jogador
sistemaRooms.obterSalaDoJogador(socketId);

// Listar salas públicas
sistemaRooms.listarSalasPublicas();

// Obter estatísticas
sistemaRooms.obterEstatisticas();
// Retorna: {totalSalas, totalJogadores, salasPublicas, salasPrivadas}
```

---

## 🔒 Limpeza Automática

- **Quando sala fica vazia**: A sala é automaticamente deletada da memória
- **Quando jogador desconecta**: Jogador é removido da sala
- **Quando último jogador sai**: Sala é destruída

---

## 🎯 Recursos Implementados

### ✅ Obrigatórios
- [x] Interface de salas (modal)
- [x] Criação de salas com configurações
- [x] Entrar em salas existentes
- [x] Gerenciamento completo de salas
- [x] Sala de teste automática (tecla T)
- [x] Sistema de espectador
- [x] Eventos Socket.IO
- [x] Código modular e comentado

### 🎁 Extras Inclusos
- [x] Modal responsivo (funciona em mobile)
- [x] Validações tanto no cliente quanto servidor
- [x] System de mensagens de status
- [x] Listagem de salas públicas
- [x] Cópia de código com um click
- [x] Configuração automática de salas
- [x] Proteção contra spam de eventos
- [x] Logs detalhados no console

---

## 🧪 Como Testar

### Teste 1: Criar Sala
1. Abra 2 abas do navegador
2. Na primeira aba, pressione **R**
3. Vá para "Criar Sala"
4. Preencha os dados
5. Clique "Criar Sala"
6. Copie o código gerado
7. Na segunda aba, pressione **R**
8. Vá para "Entrar em Sala"
9. Cole o código
10. Clique "Entrar"

### Teste 2: Sala de Teste
1. Pressione **T**
2. Deve entrar automaticamente em uma sala de teste

### Teste 3: Lista de Salas Públicas
1. Pressione **R**
2. Vá para "Entrar em Sala"
3. Clique "Atualizar Lista"
4. Você deve ver as salas criadas outras abas

### Teste 4: Fechar Sala
1. Crie uma sala privada
2. Vá para "Minha Sala"
3. Clique "Fechar Sala"
4. A sala deve desaparecer da lista

---

## 🐛 Troubleshooting

### Problema: Modal não abre ao pressionar R
- **Solução**: Verifique se o arquivo `roomUI.js` foi carregado
- Abra o console (F12) e procure por `[ROOMSUI]`

### Problema: Não consegue entrar em sala
- **Verifique**: Código da sala está correto?
- **Verifique**: Se é privada, senha está correta?
- **Verifique**: Sala não está cheia?

### Problema: Sala não é deletada ao sair
- **Info**: Salas vazias são deletadas automaticamente
- Se a sala continua aparecendo, atualize a lista

### Problema: Erro de conexão Socket.IO
- Verifique se o servidor está rodando
- Verifique a porta (padrão: 3000)
- Abra console e procure por erros

---

## 📝 Logs Console

O sistema registra tudo no console para facilitar debug:

```
[ROOMSUI] Sistema de UI de salas inicializado
[SOCKET] Sala criada com sucesso: ABCD12
[ROOMS] Sala criada: ABCD12 por socket-id-xxx
[SPECTATOR] Modo espectador iniciado
[TESTROOM] Sala de teste criada
```

---

## 🚀 Próximos Passos (Sugestões)

1. **Persistência de Dados**: Salvar salas em banco de dados
2. **Chat de Sala**: Adicionar chat entre jogadores da sala
3. **Ranking**: Mostrar placar dentro da sala
4. **Convites**: Convidar amigos para sala
5. **Salas Temporárias**: Salas que expiram após X minutos
6. **Admin de Sala**: Kick de jogadores, mudar configurações
7. **Webhooks**: Notificações quando sala é criada/deletada

---

## 📞 Suporte

Se encontrar problemas:

1. Verifique os logs do console (F12)
2. Verifique os logs do servidor (terminal Node.js)
3. Verifique se todos os arquivos foram criados
4. Reinicie o servidor
5. Limpe o cache do navegador

---

## ✨ Bom Jogo!

Seu sistema de salas está **100% funcional** e pronto para produção!

**Atalhos principais:**
- **R** = Gerenciador de Salas
- **T** = Sala de Teste
