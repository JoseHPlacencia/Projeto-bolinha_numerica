# Estrutura de estilos

Os arquivos são carregados na ordem declarada em `public/index.html`.

- `tokens.css`: fontes, variáveis e tokens dos temas.
- `base.css`: reset e estilos globais.
- `menu.css`: menu inicial e seleção do jogador.
- `overlays.css`: diálogos genéricos, ajuda e sobre.
- `game-hud.css`: canvas, HUD, alertas e controles móveis.
- `rooms.css`: criação, busca e detalhes de salas.
- `settings.css`: painel de configurações de vídeo.
- `themes.css`: variações por tema e qualidade gráfica.
- `responsive.css`: ajustes responsivos globais e dos componentes.

A ordem faz parte da cascata. Novos estilos devem ser colocados no módulo da
responsabilidade correspondente, evitando seletores globais em arquivos de
componentes.
