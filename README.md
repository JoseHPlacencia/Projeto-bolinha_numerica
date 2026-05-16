# O Projeto

O presente projeto consiste em uma extensão universiária dos alunos da turma CC1N de 2026 da UVV, 1° Período de Ciência da Computação, sob a orientação do professor Alessandro Bertolani Oliveira, na matéria Fundamentos de Tecnologia da Computação.  
Sua concepção visa por em prática a ODS 4 - Educação de Qualidade - através da gamificação aplicada à matemática do ensino fundamental e médio, abordando como tema a Teoria dos Conjuntos.

## Desenvolvimento

Como entrega principal do projeto, a equipe optou por desenvolver um jogo multiplayer, nos moldes do já existente paper.io, aplicando como mecânica base elementos de teoria dos conjuntos.  
A solução tecnológica empregada no jogo consiste em node.js para o backend, biblioteca socket.io para a comunicação com o frontend, e a biblioteca js-angus-clipper para algumas operações geométricas.

## Instruções

**Para rodar o projeto localmente:**
- Permita temporáriamente a execução de scripts no powershell usando `Set-ExecutionPolicy Unrestricted` (isso pode ser necessário para a instalação do [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) embutido no node.js). Após o término dos passos seguintes, basta restringir novamente a política usando `Set-ExecutionPolicy RemoteSigned`.
- Instale o [node.js](https://nodejs.org/pt-br/download), habilite a caixa de instalação de dependências.
- Clone o repositório e instale as dependências usando `npm install`.
- Rode o servidor node usando `node --watch server.js`.
- Se desejar, use um serviço de túnel e compartilhe o link/ip para jogar com alguém em outra rede.
