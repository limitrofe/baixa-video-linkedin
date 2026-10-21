# Baixa Vídeo LinkedIn

Extensão do Chrome para baixar vídeos de posts do LinkedIn — do jeito mais
direto que a página permitir, sem sair do site e sem mandar o link para serviço
de terceiro.

Funciona também no Edge, Brave, Vivaldi e Opera (mesmo motor).

## Instalação

1. Baixe/clone esta pasta em um lugar fixo (não mova depois).
2. Abra `chrome://extensions`.
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha esta pasta.
5. Fixe o ícone na barra (opcional, mas recomendado).

Entre na sua conta do LinkedIn normalmente. A extensão usa a sessão que já está
aberta na aba — não pede senha e não guarda login.

## Como usar

**1. Pelo botão no vídeo (mais rápido)**
Passe o mouse sobre qualquer vídeo na página. Aparece um botão redondo no canto
superior direito. Um clique baixa o arquivo na melhor qualidade disponível.

**2. Pelo popup**
Clique no ícone da extensão. Ele mostra quantas opções de arquivo aquele post
oferece e permite escolher uma qualidade específica.

> **Se o popup disser que não achou nada:** dê play no vídeo por uns 2 segundos e
> abra o popup de novo. O LinkedIn só pede o arquivo do vídeo ao servidor quando
> ele começa a tocar — e a extensão pega o endereço justamente desse pedido.

**3. Colando um link**
No popup, cole o endereço do post no campo de baixo. A extensão lê a página com
a sua sessão e lista os vídeos.

## Por que às vezes demora mais

O LinkedIn entrega vídeo de duas formas, e elas são bem diferentes:

| O que a página oferece | O que a extensão faz | Quanto demora |
| --- | --- | --- |
| **MP4 inteiro** (o caso comum) | manda o endereço direto para o Chrome | segundos |
| **Lista de pedaços** (HLS) | baixa todos os pedaços em paralelo e junta num arquivo | segundos, sem reencode |
| **Nada acessível** | grava a imagem na tela em tempo real | o tempo do vídeo |

Se os dois primeiros caminhos falharem, aparece um aviso; **clique de novo** e a
extensão grava o vídeo em tempo real (o vídeo toca do começo ao fim e você
recebe um `.mp4` ou `.webm`).

Arquivos vindos de "lista de pedaços" podem sair como `.ts` (o formato dos
pedaços, aceito por qualquer player). Para virar `.mp4` sem perder qualidade, o
computador precisa ter o `ffmpeg`:

```bash
ffmpeg -i linkedin-fulano-123.ts -c copy linkedin-fulano-123.mp4
```

## Nomes dos arquivos

```
linkedin-matthieulorrain-7518320846965379072-1080p.mp4
```

O número no meio é o identificador do post — serve para achar o original depois.

## Privacidade

- Sem telemetria, sem servidor próprio, sem analytics.
- A extensão fala só com `www.linkedin.com` (para ler a página) e com os
  servidores de mídia do próprio LinkedIn (`*.licdn.com`).
- Ela observa os pedidos de arquivo feitos por essas páginas para descobrir onde
  está o vídeo — mas **não lê, não guarda e não envia o conteúdo** desses
  arquivos. Guarda só o endereço, por até 45 minutos, e só da aba em uso.
- Guarda apenas a qualidade preferida (`storage.sync`) e, temporariamente, qual
  post está aberto em cada aba (`storage.session`, some ao fechar o navegador).

## Limitações

- **Precisa estar logado.** O vídeo só existe para quem tem acesso ao post.
- **Os endereços expiram.** Os links de mídia do LinkedIn valem algumas horas;
  baixe com a página aberta. Não adianta guardar o link para depois.
- **Posts de terceiros têm dono.** Baixar para estudo ou arquivo pessoal é uma
  coisa; republicar sem autorização é outra — e o contrato de uso do LinkedIn
  também não permite. O risco prático disso é a conta.
- **Vídeos ao vivo e LinkedIn Learning** não são suportados (outro tipo de
  transmissão, com proteção própria).
- **A tela do LinkedIn muda.** Se um dia o botão parar de aparecer, o conserto é
  pontual em `content/content.js` (onde o vídeo é procurado) ou em
  `lib/video.js` (onde os endereços são lidos).

## Como funciona por dentro

```
clique ──► content script (acha o vídeo no post)
              │  lê data-sources e os blocos <code> da página
              ▼
        service worker
              │
      ┌───────┴────────┐
      ▼                ▼
  MP4 inteiro      lista de pedaços
      │                │
      │                ▼
      │         offscreen.html (junta os pedaços)
      ▼                │
 chrome.downloads ◄────┘
```

- `lib/video.js` — encontra os endereços na página (`data-sources`, JSON com
  `progressiveStreams`/`adaptiveStreams`) e escolhe a qualidade.
- `lib/hls.js` — lê a lista de pedaços, baixa em paralelo, descriptografa
  AES-128 quando existe e devolve os bytes na ordem.
- `offscreen.js` — página invisível que monta o arquivo e entrega ao Chrome
  (só ela pode criar `Blob`).
- `content/content.js` — o botão no vídeo e a gravação em tempo real de reserva.
- `background.js` — além de orquestrar tudo, anota os endereços de vídeo que a
  página pede na rede. É a fonte que salva o dia quando o HTML não traz nada.

## Desenvolvimento

```bash
npm test
```

Os testes cobrem a leitura de links, a extração de endereços de uma página real
e o remontador de pedaços (inclusive com um servidor de mentira, sem tocar na
rede).

## Licença

MIT. Os ícones fazem parte do projeto.

Vídeos continuam sendo dos autores originais.
