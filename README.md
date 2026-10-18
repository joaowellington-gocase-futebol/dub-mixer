# DUB-MIXER — Sound System Studio

Mesa de mixagem dub / reggae / sound system para **macOS, Windows e Android**, com o mesmo código (Web Audio + Electron + Capacitor).

## Feito para quem não é músico

- **4 abas, sem rolar a tela**: MÚSICAS (decks + efeitos rápidos), MIXER, EFEITOS (sirene, eco, reverb, phaser) e SONS.
- **Tudo em português**, com explicação ao passar o mouse e um botão **AJUDA** com guia rápido.
- **Linha SEPARAR em cada deck**: TUDO / SEM VOZ / SÓ VOZ / SÓ BATIDA, mais o volume do deck.
- **Barra EFEITOS LIGADOS**: mostra todo efeito ativo (eco, reverb, sirene, filtros, voz tirada, repetição…) com o tempo ligado; clique para desligar ou use **■ PARAR TUDO**. A **LINHA DO TEMPO** mostra o que foi usado no último minuto.
- **Mesa dos sons**: botões giratórios de volume, eco e reverb para a buzina, tiro, laser e seus samples, e volume, eco e FINAL da sirene, mais **■ CORTAR SONS**.

## O que tem

**4 decks**: abrir MP3/WAV/FLAC/OGG/M4A (botão **＋ ABRIR MÚSICA**, botão ABRIR do deck, clique no deck vazio ou arrastar e soltar), waveform colorida (vermelho = grave, verde = agudo), BPM automático, pitch ±8/16/50 %, SYNC, CUE, 4 hot cues, loops de 1/2/4/8/16 tempos, **BRAKE** (para o disco) e **REWIND** (pull up! volta do CUE).

**Canais com separação de stems em tempo real**: VOZ / BATERIA / BAIXO / RESTO, cada um com knob de nível e kill. Atalhos: **DUB** (drum & bass), **INST** (sem voz), **ACAP** (só voz), **FULL**.
Também em cada canal: gain, pan, **big knob hi-pass** (estilo Altec do King Tubby), low-pass + ressonância, EQ 3 bandas com kill, sends de ECHO e SPRING com botão **THROW**, mute/solo, fader de 100 mm e VU.

**Efeitos de dub clássicos**
- **Tape Echo** (Space-201): sincronizado ao BPM (1/16 até 1 compasso, pontuado e tercina) ou tempo livre (girar o TIME com o eco tocando faz o efeito de pitch da fita), feedback até auto-oscilação, saturação, wow & flutter, tom, spread estéreo, FREEZE, THROW ALL, CLEAR.
- **Spring Reverb** de dois tanques com "drip" e **CRASH!** (chutar a mola).
- **Bi-Phase** (phaser estilo Black Ark) no master.
- **Dub Siren** (VCO + LFO) com 8 presets: Classic, Riser, Laser, Warble, Alarm, Deep Siren, Bird, Spaceship. Botão segurar ou LATCH.
- **Pads de sound system**: Air Horn, Gun Shot, Laser, Bomb, Zap, Riser, Sub Drop, Rim Shot, Siren, Spring Crash, Echo Throw, Bass Drop, Dub Out, No Vocal, Echo Freeze, Echo Clear.
- **8 pads de dubplate/samples**: carregue seus próprios arquivos (ficam salvos no app).

**Master**: DJ filter bipolar com ressonância, EQ de sound system (Sub 65, Low 220, Presence 3k, Air 10k), compressão "glue", limiter brickwall + soft clip, VU estéreo, LEDs LIMIT/CLIP, analisador de espectro.

**Presets de estilo**: Tubby's Hi-Fi, Scientist, Black Ark, Ariwa Digital, Sound System, UK Steppers, Lovers Rock, Digi Dancehall + presets próprios (SALVAR).

**Gravação e exportação**: REC grava o master em 32-bit float. No **Export Studio**: cortar início/fim, fade in/out, normalizar, título/artista/álbum/ano/gênero/comentário, **capa** (sua imagem ou gerada automaticamente) embutida no arquivo, exportar **WAV 16/24/32-bit** ou **MP3 192/256/320 kbps**, ou mandar a gravação de volta para um deck (para fazer remix em cima do remix).

## Atalhos de teclado (desktop)

| Tecla | Ação |
|---|---|
| Q W E R | play/pause decks A B C D |
| A S D F (segurar) | echo throw nos canais A B C D |
| ESPAÇO (segurar) | sirene |
| 1 – 8 | pads de efeito |
| T (segurar) | joga a mix inteira no eco |
| G (segurar) | echo freeze |
| ESC | corta todos os ecos |
| B (segurar) | bass drop |
| V (segurar) | dub out (drum & bass em tudo) |
| H | spring crash |
| Y | tap tempo |
| ENTER | gravar / parar |
| duplo clique | knob/fader volta ao padrão |
| Shift + arrastar | ajuste fino |

## Instalar

- **Mac**: `DUB-MIXER-1.0.0-arm64.dmg` (Apple Silicon M1/M2/M3/M4) ou `DUB-MIXER-1.0.0-mac-intel.dmg`. O app não é assinado pela Apple: na primeira vez, clique com o botão direito no app → **Abrir** → **Abrir**.
- **Windows**: `DUB-MIXER-Setup-1.0.0.exe` (instalador) ou `DUB-MIXER-Portable-1.0.0.exe` (sem instalar). Se o SmartScreen avisar: **Mais informações → Executar assim mesmo**.
- **Android**: `DUB-MIXER-1.0.0.apk`. Copie para o celular e abra (permita "instalar apps desconhecidos"). Android 7 ou superior. Use o celular deitado. As exportações vão para `Documentos/DUB-MIXER` e abrem o menu de compartilhar.

## Gerar os builds

```bash
npm install
npm run dev            # versão web para desenvolvimento (http://localhost:5199)
npm run dist:mac       # DMGs de Mac em release/
npm run dist:win       # instalador + portátil de Windows em release/
npm run android:sync   # copia o app para o projeto Android
cd android && ./gradlew assembleRelease   # APK assinado em android/app/build/outputs/apk/release/
```

Ou tudo de uma vez (no Mac), com os arquivos finais em `release/final/`:

```bash
./scripts/build-all.sh
```

Android precisa de JDK 17+ (`JAVA_HOME`) e Android SDK 34 (`ANDROID_HOME`).
A chave de assinatura do Android fica em `android/dubmixer-release.keystore` + `android/keystore.properties`. **Guarde esses dois arquivos com backup** — sem eles não dá para publicar atualizações do mesmo app.

## Sobre a separação de stems

A separação é feita por DSP em tempo real (STFT + separação harmônico/percussiva + detecção de centro estéreo), então funciona instantaneamente em qualquer aparelho, inclusive no celular, sem esperar processamento. Com todos os stems no máximo o som sai idêntico ao original (reconstrução perfeita).

Limitações honestas desse método:
- Funciona melhor em músicas **estéreo**; vozes centralizadas saem bem, mas instrumentos também centralizados podem vazar para o stem de voz.
- O grave do **bumbo** tende a ir junto com o stem de BAIXO.
- Não chega na qualidade de separadores por IA (Demucs/Spleeter). Uma evolução natural é adicionar um modo "IA" offline no desktop.

## Estrutura

```
src/audio/engine.js        barramento master, sends, limiter, gravação
src/audio/deck.js          deck + channel strip (transporte, loops, rewind, stems, EQ, filtros)
src/audio/fx.js            tape echo, spring reverb, phaser, sirene, efeitos sound system
src/audio/worklets/        separador de stems e gravador (AudioWorklet)
src/ui/                    interface (knobs, faders, decks, export studio)
src/export/                WAV, MP3 e ID3 (capa)
electron/                  app desktop
android/                   app Android (Capacitor)
tests/                     testes de DSP offline (rodar no navegador do npm run dev)
```
