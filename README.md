# Natural PDF Studio

Editor web estático para trabalhar com **um documento por vez**.

Ele permite:

- abrir um PDF para leitura;
- selecionar e copiar o texto renderizado;
- dar duplo clique em um trecho de texto e criar uma substituição editável sobre ele;
- inserir caixas de texto, imagens, coberturas brancas e realces;
- arrastar, redimensionar, duplicar e organizar os elementos;
- excluir, duplicar e reordenar páginas;
- acrescentar páginas A4 a um PDF existente;
- criar um documento A4 do zero;
- escolher margens normais, compactas, amplas ou no padrão ABNT;
- escolher espaçamento 1,15, 1,5 ou 2,0;
- desfazer ações estruturais com Ctrl+Z;
- arrastar um PDF, uma imagem ou um projeto direto para a janela;
- ajustar o zoom com Ctrl + rolagem do mouse ou Ctrl + "+" / "-";
- salvar o projeto completo para continuar depois;
- exportar o resultado em PDF ou HTML autônomo.

## Como abrir no Windows

A forma recomendada é executar:

```text
iniciar-windows.bat
```

O arquivo abre um servidor local na porta 4173 e tenta abrir o navegador automaticamente.

Também é possível abrir o `index.html` diretamente, mas alguns navegadores bloqueiam o carregamento do mecanismo de PDF quando o projeto é aberto por `file://`. Por isso, use o servidor local ou publique o projeto.

## Como abrir no macOS ou Linux

No terminal, dentro da pasta:

```bash
chmod +x iniciar.sh
./iniciar.sh
```

Ou:

```bash
python3 -m http.server 4173
```

Depois abra `http://localhost:4173`.

## Publicação no GitHub Pages

O projeto é totalmente estático e já vem pronto para o GitHub Pages, publicado direto da branch:

1. Envie **o conteúdo desta pasta para a raiz** da branch `main` (o `index.html` deve ficar na raiz, não dentro de uma subpasta).
2. Em **Settings → Pages → Build and deployment → Source**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. A cada push na `main`, o GitHub publica o site em `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

Todos os caminhos do projeto são relativos, então ele funciona tanto em `usuario.github.io` quanto em `usuario.github.io/repositorio/` sem nenhum ajuste. O arquivo `.nojekyll` incluído impede que o GitHub processe o site com Jekyll.

## Funcionamento da edição de PDFs existentes

Um PDF não funciona internamente como um documento Word. O texto pode estar fragmentado em centenas de comandos gráficos, fontes incorporadas ou imagens digitalizadas.

Por isso, este editor usa uma abordagem visual:

1. o PDF original é renderizado como base da página;
2. o texto extraído forma uma camada selecionável;
3. ao dar duplo clique em um trecho, o editor identifica o **parágrafo inteiro** (linhas com o mesmo alinhamento e espaçamento, inclusive dentro de células de tabela) e o transforma numa caixa editável com a mesma largura de coluna, fonte, tamanho, cor, negrito/itálico, recuo e justificação;
4. o texto original do parágrafo é apagado da imagem da página e substituído pela caixa;
5. ao editar, o texto quebra as linhas sozinho. Se o parágrafo crescer, **tudo o que vem abaixo dele desce junto**: parágrafos, tabelas (a linha da tabela cresce e as bordas acompanham) e elementos inseridos. Se ele diminuir, o conteúdo sobe de volta até a posição original.

Detalhes do ajuste de linhas:

- dentro de uma tabela, o parágrafo usa primeiro o espaço livre que já existe na célula antes de empurrar a tabela;
- em páginas com colunas lado a lado, só a coluna editada desce;
- se o conteúdo empurrado passar da margem inferior, a página é alongada para não cortar nada (o conteúdo não passa automaticamente para a página seguinte);
- PDFs feitos com as fontes DejaVu usam as cópias incluídas em `vendor/fonts`; para outras fontes, o editor usa a fonte equivalente do sistema e ajusta o espaçamento para manter as mesmas quebras de linha.

Essa abordagem preserva o visual do PDF e funciona inclusive quando a estrutura interna do arquivo é irregular. Ela não reescreve os objetos internos do PDF original.

## Exportações

### PDF

O botão **PDF** gera o arquivo diretamente no navegador. O resultado preserva visualmente:

- as páginas originais;
- os textos substituídos;
- as imagens;
- os realces;
- as páginas A4 criadas no editor.

A exportação direta é visual e rasterizada. Em documentos muito grandes, a qualidade é ajustada automaticamente para reduzir uso de memória.

### HTML

O botão **HTML** cria um único arquivo `.html` que contém:

- as páginas do PDF convertidas em imagens incorporadas;
- a camada de texto pesquisável;
- os elementos adicionados;
- os textos das páginas A4 como HTML real;
- um botão para imprimir ou salvar novamente como PDF.

Não é necessário manter uma pasta de imagens junto do HTML exportado.

### Projeto editável

O botão **Salvar projeto** gera um arquivo:

```text
nome-do-documento.natural-pdf.json
```

Esse arquivo contém as páginas, edições, imagens e, quando aplicável, o PDF original incorporado. Use **Abrir projeto** para continuar a edição.

## Salvamento automático

O editor salva a sessão no IndexedDB do navegador. Ao reabrir o site, aparece a opção de restaurar a última sessão.

Os dados são processados localmente. O projeto não possui backend e não envia o PDF para um servidor.

## Estrutura

```text
natural_pdf_editor/
├── index.html
├── styles.css
├── app.js
├── .nojekyll
├── iniciar-windows.bat
├── iniciar.sh
└── vendor/
    ├── pdf.min.js
    ├── pdf.worker.min.js
    ├── html2canvas.min.js
    ├── jspdf.umd.min.js
    ├── jszip.min.js
    ├── cmaps/
    ├── standard_fonts/
    ├── fonts/          (DejaVu Sans/Serif em WOFF2, para casar com PDFs que usam essas fontes)
    └── licenses/
```

## Bibliotecas incluídas

- Mozilla PDF.js
- html2canvas
- jsPDF
- JSZip

As licenças estão na pasta `vendor/licenses`.

## Limitações relevantes

- PDFs digitalizados como imagem não possuem texto original selecionável; ainda é possível cobrir áreas e inserir novos textos.
- O projeto não executa OCR.
- A edição de texto existente é uma substituição visual, não uma alteração semântica do objeto textual original.
- PDFs com muitas páginas podem levar alguns minutos para exportar.
- O PDF exportado diretamente é rasterizado. O HTML mantém texto pesquisável nas páginas A4 e uma camada textual invisível nas páginas importadas.
