# Vennperio

Vennperio é um jogo multiplayer inspirado em Paper.io 2 que usa teoria dos conjuntos como parte da mecânica. O projeto é uma atividade de extensão universitária da turma CC1N de 2026 da Universidade Vila Velha, desenvolvida para apoiar a ODS 4 — Educação de Qualidade — por meio da gamificação da matemática.

O jogo está em versão alpha e permanece em desenvolvimento. A versão pública pode ser acessada em [vennperio.site](https://vennperio.site).

## Tecnologias

- Node.js e Express no servidor;
- Socket.IO para comunicação em tempo real;
- Canvas 2D e `OffscreenCanvas`/Web Worker na renderização;
- `polygon-clipping` nas operações de território.

## Execução local

Requisitos: Node.js 20 ou superior e npm.

```bash
npm ci
npm run dev
```

O servidor usa `http://localhost:3000` por padrão. A porta pode ser alterada com a variável de ambiente `PORT`, e o endereço de escuta com `HOST`.

Para uma execução sem reinício automático:

```bash
npm start
```

No PowerShell, caso a política local bloqueie apenas o wrapper `npm.ps1`, use `npm.cmd` nos mesmos comandos; não é necessário liberar irrestritamente a execução de scripts do sistema.

## Validação

```bash
npm run check
npm test
```

`npm run check` verifica automaticamente a sintaxe dos arquivos JavaScript do servidor, cliente e scripts. `npm test` executa a suíte versionada em `test/`; os dois comandos também são executados no GitHub Actions.

## Organização

- `src/`: servidor autoritativo, regras de jogo, geometria e serialização;
- `public/`: interface, input, interpolação de snapshots e renderização;
- `test/`: testes automatizados de regras, geometria e protocolo de snapshots;
- `scripts/`: ferramentas versionadas de desenvolvimento;
- `.ai/`: contexto e documentação de desenvolvimento local; não é versionada.
