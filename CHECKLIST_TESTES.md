# 🧪 CHECKLIST DE TESTES - SISTEMA DE SALAS ONLINE

## 📋 Estrutura de Testes

- [ ] **Testes de Criação**
- [ ] **Testes de Entrada**
- [ ] **Testes de Validação**
- [ ] **Testes de UI**
- [ ] **Testes de Performance**
- [ ] **Testes de Edge Cases**

---

## 🔨 TESTES DE CRIAÇÃO

### Criar Sala Pública
- [ ] Abra o modal (R)
- [ ] Vá para "Criar Sala"
- [ ] Preencha nome: "Teste Público"
- [ ] Selecione tipo: "Pública"
- [ ] Clique "Criar Sala"
- [ ] Verifique se código foi gerado (formato: 4 letras + 2 números)
- [ ] Verifique se mensagem "Sala criada" aparece
- [ ] Verifique se você está na sala (aba "Minha Sala")

### Criar Sala Privada
- [ ] Abra o modal (R)
- [ ] Vá para "Criar Sala"
- [ ] Preencha nome: "Teste Privado"
- [ ] Selecione tipo: "Privada"
- [ ] Verifique se campo de senha aparece
- [ ] Digite senha: "minhaSenha123"
- [ ] Clique "Criar Sala"
- [ ] Verifique se sala foi criada
- [ ] Verifique se tipo mostra "🔒 Privada"

### Validação de Criação
- [ ] Tente criar sala sem nome → Deve mostrar erro
- [ ] Tente criar sala privada sem senha → Deve mostrar erro
- [ ] Tente criar sala privada com senha vazia → Deve mostrar erro

### Códigos Únicos
- [ ] Crie 5 salas diferentes
- [ ] Verifique se todos os códigos são diferentes
- [ ] Verifique se códigos seguem o padrão (4 letras + 2 números)

---

## 🚪 TESTES DE ENTRADA

### Entrar por Código Correto
- [ ] Crie uma sala pública
- [ ] Copie o código
- [ ] Abra o modal em nova aba (R)
- [ ] Vá para "Entrar em Sala"
- [ ] Digite o código
- [ ] Clique "Entrar"
- [ ] Verifique se entrou na sala
- [ ] Verifique se o código aparece em "Minha Sala"

### Entrar em Sala Privada
- [ ] Crie uma sala privada (senha: "teste")
- [ ] Copie o código
- [ ] Tente entrar sem senha
- [ ] Deve mostrar erro "Senha incorreta"
- [ ] Digite a senha correta
- [ ] Deve entrar na sala

### Entrar da Lista
- [ ] Crie uma sala pública
- [ ] Abra modal em nova aba
- [ ] Vá para "Entrar em Sala"
- [ ] Clique "Atualizar Lista"
- [ ] Verifique se sua sala aparece
- [ ] Clique no botão "Entrar" da sala
- [ ] Verifique se entrou

### Validações de Entrada
- [ ] Tente entrar sem digitar código → Deve mostrar erro
- [ ] Tente entrar com código inválido → Deve mostrar erro
- [ ] Tente entrar em sala que não existe → Deve mostrar erro
- [ ] Tente entrar em sala cheia → Deve mostrar erro

### Múltiplos Jogadores
- [ ] Abra 3 abas
- [ ] Crie uma sala na aba 1
- [ ] Copie o código
- [ ] Entra nas abas 2 e 3
- [ ] Verifique se "Minha Sala" mostra 3 jogadores em cada aba
- [ ] Saia de uma aba
- [ ] Verifique se o contador diminui

---

## ✅ TESTES DE VALIDAÇÃO

### Limite de Jogadores
- [ ] Crie uma sala com max 2 jogadores
- [ ] Tente entrar com 3 jogadores
- [ ] O 3º deve receber erro "Sala cheia"

### Configurações Padrão
- [ ] Crie uma sala com todas as configurações padrão
- [ ] Verifique em "Minha Sala":
  - [ ] Raio do Mapa: 1500
  - [ ] Raio da Base: 200
  - [ ] Velocidade: 600
  - [ ] Max Jogadores: 10

### Range de Valores
- [ ] Tente definir raio do mapa como -100 → Deve usar mínimo (500)
- [ ] Tente definir raio do mapa como 10000 → Deve usar máximo (5000)
- [ ] Mesmo para outros campos

---

## 🎨 TESTES DE UI

### Modal Responsivo
- [ ] Abra em desktop (1920x1080)
- [ ] Verifique se modal cabe na tela
- [ ] Redimensione para tablet (768x1024)
- [ ] Verifique se modal se adapta
- [ ] Redimensione para mobile (375x667)
- [ ] Verifique se modal permanece usável

### Abas
- [ ] Clique em cada aba
- [ ] Verifique se muda o conteúdo
- [ ] Verifique se aba ativa fica azul
- [ ] Verifique se conteúdo não mistura

### Buttons e Inputs
- [ ] Digite em campos de texto
- [ ] Use sliders
- [ ] Clique em buttons
- [ ] Todos devem responder corretamente

### Mensagens de Status
- [ ] Crie uma sala → Deve mostrar mensagem verde "Sala criada"
- [ ] Tente erro → Deve mostrar mensagem vermelha
- [ ] Mensagem deve desaparecer após 3 segundos

### Campos Dinâmicos
- [ ] Selecione "Privada"
- [ ] Campo de senha deve aparecer
- [ ] Selecione "Pública"
- [ ] Campo de senha deve desaparecer

---

## ⚡ TESTES DE PERFORMANCE

### Muitas Salas
- [ ] Crie 20 salas públicas
- [ ] Clique "Atualizar Lista"
- [ ] UI deve permanecer responsiva
- [ ] Lista deve carregar em < 1 segundo

### Muitos Jogadores
- [ ] Abra 10 abas
- [ ] Crie sala com 10 slots
- [ ] Entra todos em 10 abas
- [ ] Todos devem entrar sem lag

### Latência de Rede
- [ ] (Abra DevTools → Network → Throttling)
- [ ] Defina para "Slow 3G"
- [ ] Tente criar e entrar em salas
- [ ] Deve funcionar (apenas mais lento)

---

## 🎯 TESTES DE EDGE CASES

### Desconexão
- [ ] Abra uma sala
- [ ] Desconecte a internet (simule desconexão)
- [ ] Reconecte
- [ ] Deve restaurar o estado

### Fechar Aba
- [ ] Crie uma sala
- [ ] Feche a aba completamente
- [ ] Abra nova aba
- [ ] Sala anterior deve ter desaparecido (último jogador saiu)

### Múltiplos Modais
- [ ] Abra modal
- [ ] Pressione R novamente
- [ ] Modal deve fechar
- [ ] Pressione R novamente
- [ ] Modal deve abrir
- [ ] Deve funcionar sempre

### Sair e Entrar
- [ ] Entre em sala
- [ ] Clique "Sair"
- [ ] Entre na mesma sala novamente
- [ ] Deve funcionário normal

### Caracteres Especiais
- [ ] Tente criar sala com nome: "Sala & Testes! #123"
- [ ] Deve aceitar ou sanitizar

### Nomes Longos
- [ ] Crie sala com nome muito longo (100 caracteres)
- [ ] UI não deve quebrar
- [ ] Deve truncar em "Minha Sala"

---

## 🔑 TESTES DE ATALHOS

### Atalho R (Abrir Modal)
- [ ] Pressione R
- [ ] Modal deve abrir
- [ ] Pressione R novamente
- [ ] Modal deve fechar
- [ ] Pressione R outras 10 vezes
- [ ] Deve alternar corretamente

### Atalho T (Sala de Teste)
- [ ] Pressione T
- [ ] Deve entrar em sala TESTE123
- [ ] Se não existir, deve criar automaticamente
- [ ] Pressione T novamente
- [ ] Deve sair e tentar entrar novamente

---

## 🔌 TESTES DE SOCKET.IO

### Eventos são Emitidos
- [ ] Abra Console (F12)
- [ ] Crie uma sala
- [ ] Verifique se no servidor aparece `[SOCKET] Sala criada com sucesso`

### Callbacks Funcionam
- [ ] Todos os eventos devem chamar o callback
- [ ] Callback deve receber `sucesso: true` ou `false`
- [ ] UI deve responder ao callback

### Broadcast Funciona
- [ ] Crie sala em aba 1
- [ ] Vá para aba 2
- [ ] Clique "Atualizar Lista"
- [ ] Nova sala deve aparecer

---

## 📊 TESTES DE DADOS

### Sala de Teste
- [ ] Pressione T
- [ ] Verifique se entrou na sala TESTE123
- [ ] Verificar em "Minha Sala" se dados estão corretos
- [ ] Saia
- [ ] Pressione T novamente
- [ ] Deve entrar na mesma sala

### Persistência Entre Abas
- [ ] Crie sala em aba 1
- [ ] Abra aba 2
- [ ] Entra na sala em aba 2
- [ ] Abra aba 3
- [ ] Visualize a sala em aba 3 (lista)
- [ ] Dados devem ser consistentes

### Remoção Automática
- [ ] Crie uma sala
- [ ] Visualize em "Entrar em Sala" → "Atualizar Lista"
- [ ] Saia completamente (feche a aba)
- [ ] Atualize lista novamente
- [ ] Sala deve ter desaparecido (última saiu)

---

## 🎬 TESTES DE ESPECTADOR (Extra)

### Modo Espectador
- [ ] Crie uma sala pública com jogadores
- [ ] (Se implementado) Ative modo espectador
- [ ] Deve selecionar uma sala aleatória
- [ ] Deve observar um jogador

---

## 📝 Resultados dos Testes

```
Total de Testes: [ ] / [ ]
Testes Passaram:  [ ] / [ ]
Taxa de Sucesso:  [ ]%

Data: ___________
Testador: ___________
Notas:
_________________________________________________
_________________________________________________
```

---

## 🚀 Checklist Final de Deploy

Antes de enviar para produção:

- [ ] Todos os testes passaram
- [ ] Sem erros no console do navegador
- [ ] Sem erros no console do servidor
- [ ] Performance aceitável em conexão 3G
- [ ] UI responsiva em todos os tamanhos
- [ ] Validações funcionando
- [ ] Mensagens de erro claras
- [ ] Sem memory leaks (DevTools)
- [ ] Código comentado
- [ ] Documentação atualizada
- [ ] Atalhos funcionando
- [ ] Modal acessível

---

## 📚 Referência Rápida

| Funcionalidade | Atalho | Teste |
|---|---|---|
| Abrir Modal | R | [ ] |
| Sala de Teste | T | [ ] |
| Criar Sala | Modal → Aba 2 | [ ] |
| Entrar em Sala | Modal → Aba 1 | [ ] |
| Fechar Sala | Modal → Aba 3 | [ ] |
| Ver Salas | Modal → Atualizar | [ ] |

---

**Boa Sorte com os Testes! 🧪✨**
