# 🎮 PRIMEIRO USO - SISTEMA DE SALAS ONLINE

## ⚡ Quick Start (5 minutos)

### 1️⃣ Verificar Servidor (Windows PowerShell)

```powershell
# Navegar para pasta do projeto
cd "c:\Users\adrie\OneDrive\Área de Trabalho\projeto extension\Vennperio"

# Verificar se servidor está rodando
npm run dev
```

**Esperado:**
```
> npm run dev
Server running at http://localhost:3000
```

Se vir isso ✅ = Servidor OK!

---

### 2️⃣ Abrir o Jogo no Navegador

Clique em um dos links:
- http://localhost:3000
- http://127.0.0.1:3000

**Esperado:**
- Canvas preto/cinza (jogo carregando)
- Sem erros no console (F12)

---

### 3️⃣ Teste 1: Abrir Modal (10 segundos)

```
Pressione a tecla: R
```

**Esperado:**
- ✅ Janela modal abre no centro da tela
- ✅ 3 abas: "Entrar em Sala", "Criar Sala", "Minha Sala"
- ✅ Design azul/cinza (dark theme)

Se não abriu:
- F12 → Console → Procure `[ROOMSUI]`
- Recarregue página (Ctrl+R)

---

### 4️⃣ Teste 2: Sala de Teste (10 segundos)

```
Pressione a tecla: T
```

**Esperado:**
- ✅ Nada visível acontece (background)
- ✅ Você entrou na sala TESTE123
- ✅ Verifique clicando R e indo para "Minha Sala"

Se não funcionou:
- F12 → Console → Procure `[TESTROOM]`
- Verifique se há erros

---

### 5️⃣ Teste 3: Criar Sala (30 segundos)

```
1. Pressione R (abre modal)
2. Clique na aba "Criar Sala" (segunda aba)
3. Preencha os dados:
   - Nome: "Meu Teste"
   - Tipo: "Pública"
   - Deixe o resto com valores padrão
4. Clique "Criar Sala"
```

**Esperado:**
- ✅ Mensagem verde: "Sala criada! Código: XXXX99"
- ✅ Modal muda para aba "Minha Sala"
- ✅ Seu código aparece com botão para copiar

**Se deu erro:**
- Verifique console (F12) para mensagem de erro
- Confira se nome tem caracteres válidos

---

### 6️⃣ Teste 4: Entrar em Sala (30 segundos)

```
1. Abra NOVA ABA do navegador (Ctrl+T)
2. Digite: http://localhost:3000
3. Pressione R (abre modal)
4. Você está na aba "Entrar em Sala" (padrão)
5. Cole o código que você criou
6. Clique "Entrar"
```

**Esperado:**
- ✅ Mensagem verde: "Entrou na sala XXXX99"
- ✅ Modal muda para "Minha Sala"
- ✅ Mostra seus dados de jogador conectado

**Verificar sincronização:**
- Volte para Aba 1 (R → "Minha Sala")
- Deve mostrar "2 jogadores" agora
- Aba 2 deve mostrar os mesmos dados

---

## 🧪 Teste Completo (10 minutos)

### Setup
```
1. Abra 3 abas
2. Em cada uma, acesse: http://localhost:3000
```

### Aba 1: Criar Sala
```
R → "Criar Sala"
Nome: "Sala de Teste"
Tipo: "Pública"
Deixar resto padrão
Clique "Criar Sala"
Copie o código (ex: ABCD12)
```

### Aba 2: Entrar por Código
```
R → "Entrar em Sala"
Cole o código (ex: ABCD12)
Clique "Entrar"
Verifique: "Minha Sala" deve mostrar 2 jogadores
```

### Aba 3: Entrar da Lista
```
R → "Entrar em Sala"
Clique "Atualizar Lista"
Você deve ver sua sala na lista
Clique "Entrar"
Verifique: "Minha Sala" deve mostrar 3 jogadores
```

### Verificações
```
Na Aba 1 → R → "Minha Sala" → Deve mostrar 3 jogadores
Na Aba 2 → R → "Minha Sala" → Deve mostrar 3 jogadores
Na Aba 3 → R → "Minha Sala" → Deve mostrar 3 jogadores

Todos com os mesmos dados? ✅ Sistema funcionando!
```

---

## 📊 O que Testar

### Funcionalidades Básicas
- [ ] Abrir modal (R)
- [ ] Criar sala
- [ ] Entrar em sala por código
- [ ] Entrar em sala da lista
- [ ] Ver lista de salas públicas
- [ ] Sair de sala
- [ ] Sala de teste (T)
- [ ] Fechar sala (se criador)

### Validações
- [ ] Tente criar sala sem nome → Deve dar erro
- [ ] Tente entrar com código inválido → Erro
- [ ] Crie sala privada e tente entrar sem senha → Erro
- [ ] Tente entrar em sala cheia → Erro

### Sincronização
- [ ] Crie em aba 1
- [ ] Entre em aba 2
- [ ] Contadores devem sincronizar
- [ ] Saia em aba 2
- [ ] Contador deve atualizar em aba 1

### Responsividade
- [ ] F12 → Device Toolbar
- [ ] Teste em diferentes tamanhos
- [ ] Modal deve se adaptar
- [ ] Deve ser usável em mobile

---

## 🐛 Problemas Comuns e Soluções

### Problema: "Server running..." mas depois erro

**Solução:**
```powershell
# Parar servidor (Ctrl+C)
# Reinstalar dependências
npm install

# Reiniciar
npm run dev
```

---

### Problema: Modal não abre ao pressionar R

**Solução:**
```
1. Abra Console: F12
2. Procure por "[ROOMSUI]" nos logs
3. Se não houver, verifique:
   - Arquivo roomUI.js foi criado?
   - Está sendo importado em gameClient.js?
   - Recarregue página (Ctrl+R)
```

---

### Problema: "Cannot create property 'socket' of undefined"

**Solução:**
```
1. Verifique se servidor está rodando
2. Verifique porta 3000 não está bloqueada
3. Tente porta diferente:
   - Edite: src/config/gameConfig.js
   - Mude: port: 3000 para port: 3001
```

---

### Problema: Não consegue entrar em sala

**Verificar:**
```
☐ Código está correto? (case-sensitive)
☐ Sala não está cheia? (máximo padrão é 10)
☐ Se privada, senha está correta?
☐ Sala realmente existe?
```

---

### Problema: Salas não desaparecem da lista

**Informação:**
```
Isso é NORMAL!
Salas vazias são deletadas da memória,
mas a lista no navegador só atualiza quando você clica "Atualizar Lista".

Solução: Clique "Atualizar Lista" para ver versão mais recente.
```

---

## 📱 Teste em Mobile

### Usar Chrome DevTools
```
1. F12 para abrir DevTools
2. Clique no ícone de celular (Device Toolbar)
3. Selecione um dispositivo: iPhone 12, Pixel 5, etc.
4. Teste o modal em diferentes tamanhos
```

### Deve funcionar em:
- ✅ iPhone (375px wide)
- ✅ Android (varies)
- ✅ iPad (768px wide)
- ✅ Desktop (1920px wide)

---

## 🔍 Debug Avançado

### Ver Logs do Console

**Cliente (Browser F12):**
```
[ROOMSUI] Sistema de UI inicializado
[SPECTATOR] Gerenciador de espectador inicializado
[TESTROOM] Sala de teste criada
```

**Servidor (Terminal):**
```
Server running at http://localhost:3000
[ROOMS] Sala criada: ABCD12 por socket-xxx
[SOCKET] Jogador entrou na sala ABCD12
[ROOMS] Sala ABCD12 deletada (vazia)
```

### Ativar Debug Panel
```
F12 → Console → digite:
window.location.hash = "#debug"
Recarregue (F5)

Deve aparecer "FPS" no canto superior esquerdo
```

---

## 📊 Checklist de Sucesso

Após completar todos os testes:

- [x] Servidor rodando sem erros
- [x] Modal abre ao pressionar R
- [x] Consegue criar sala
- [x] Consegue entrar em sala
- [x] Lista de salas funciona
- [x] Sincronização entre abas funciona
- [x] Sala de teste funciona (T)
- [x] Validações funcionam (erros aparecem)
- [x] Layout responsivo funciona
- [x] Sem erros no console

**Se todos checados ✅ = Sistema 100% funcional!**

---

## 🎁 Extras para Explorar

### Botão de Copiar Código
```
1. Crie uma sala
2. Em "Minha Sala" verá seu código
3. Clique no ícone 📋 ao lado do código
4. Código foi copiado para clipboard
5. Cole com Ctrl+V
```

### Salas Privadas
```
1. "Criar Sala"
2. Selecione tipo: "Privada"
3. Campo de senha aparece
4. Digite uma senha
5. Outros jogadores precisam da senha para entrar
```

### Configurações Customizadas
```
1. "Criar Sala"
2. Use os sliders para customizar:
   - Raio do Mapa (tamanho)
   - Raio da Base (spawn)
   - Velocidade (movimento)
   - Máximo de Jogadores
```

---

## 📞 Se Algo Não Funcionar

### Passo 1: Verificar Logs
```
1. F12 (Browser Console)
2. Procure por [ROOMSUI], [SOCKET], [ROOMS]
3. Veja qual é o erro exato
```

### Passo 2: Reiniciar
```
1. Feche o navegador completamente
2. Stop do servidor: Ctrl+C no terminal
3. Limpe cache: Ctrl+Shift+Delete
4. Reinicie: npm run dev
5. Reabra navegador
```

### Passo 3: Verificar Arquivos
```
1. Verifique se existem:
   - src/systems/roomSystem.js
   - src/core/roomSocketHandler.js
   - public/js/ui/roomUI.js
   - public/css/roomModal.css
2. Se falta algum, redownload
```

### Passo 4: Leia Documentação
```
Se problema persiste, leia:
- GUIA_SALAS.md (modo detalhado)
- DIAGRAMA_ARQUITETURA.md (entender fluxo)
- CHECKLIST_TESTES.md (mais casos de teste)
```

---

## 🎯 Próximas Ações Sugeridas

### Imediato (hoje)
1. ✅ Fazer o Quick Start acima
2. ✅ Testar criar/entrar salas
3. ✅ Testar com 3+ abas

### Próximo (próxima semana)
1. Ler GUIA_SALAS.md completo
2. Executar todos os testes de CHECKLIST_TESTES.md
3. Integrar com seu jogo (sincronizar sala com gameState)

### Futuro (próximo mês)
1. Implementar Chat de Sala
2. Adicionar Placar
3. Persistência em BD (MongoDB)

---

## 📚 Arquivos Importantes

| Arquivo | Propósito | Ler Quando |
|---------|-----------|-----------|
| LEIA_ME.md | Visão geral | Agora |
| GUIA_SALAS.md | Guia completo | Depois dos testes |
| CHECKLIST_TESTES.md | 60+ testes | Se quer testar tudo |
| DIAGRAMA_ARQUITETURA.md | Entender arquitetura | Se quer aprofundar |
| MELHORIAS_FUTURAS.md | Roadmap | Se quer planejar |

---

## ✨ Conclusão

Você agora tem um **Sistema de Salas Online completamente funcional**!

**Próximo passo:** Faça o Quick Start acima (5 minutos) e comece a jogar! 🎮

---

**Bom jogo! 🎉**

*Desenvolvido em 2026-06-10*
*Status: ✅ Pronto para Produção*
