# /jarbis-save — Deixar a sessão escrita sem fechá-la

O usuário digitou isto porque há algo que não convém perder e o trabalho
não terminou. **O comando É a confirmação** — não pergunte "devo salvar?".
Salve e depois mostre em poucas linhas o que escreveu.

Isto é `/jarbis-close` menos `end_session`. A sessão continua aberta e se
volta ao trabalho imediatamente depois.

---

## Por que existe

`save_observation` já acontece sozinho enquanto você trabalha — essa nunca
foi a falha. A falha é `set_project_state`, que até agora só ocorria no
fechamento. Então qualquer sessão que terminou sem `/jarbis-close` — uma
queda, um notebook fechado, um `/clear`, uma sessão longa que se perdeu —
deixou a seguinte lendo o estado da sessão anterior.

Essa falha é **invisível**. Nada parece quebrado: a sessão seguinte abre, o
banner imprime, o handoff está lá. Só que descreve um mundo que já mudou.
Você descobre semanas depois, quando um agente retoma com toda a confiança
um trabalho que já estava pronto.

Portanto o ponto deste comando não é pensar melhor sobre o que salvar. É
fazer com que a *sequência de chamadas* seja garantida em vez de lembrada.
O que vai em cada nota continua sendo seu critério — isso funciona, e
ninguém precisa de um comando para isso.

---

## Ordem (importa)

### 0. Primeiro olhe o estado real

Rode `git status --short`. Você está escrevendo o que EXISTE, então
descubra o que existe. Se o projeto tem testes e você os rodou, anote o
resultado; se não rodou, diga isso em vez de supor.

Diferente de `/jarbis-close`, **ter trabalho sem commit não é motivo para
parar.** Aqui é o caso normal: um checkpoint acontece no meio do trabalho.
Registre isso como parte do quadro.

### 1. Tudo desta sessão que ainda não foi salvo

Para cada decisão, gotcha, erro ou avanço desde o último salvamento:
`save_observation` com o `kind` correto, `content` ordenado POR QUÊ → O QUÊ
→ COMO, e `files`.

Para qualquer coisa que tenha um **valor atual** em vez de um histórico,
chame `suggest_topic_key` primeiro e reutilize a chave que ele devolve —
isso atualiza a nota em vez de deixar uma rival ao lado.

Não salve uma nota por arquivo tocado. Salve o que pouparia uma hora de
quem abrir isto em três semanas.

### 2. Histórias tocadas → `update_progress`

Para cada história trabalhada desde o último salvamento:
`update_progress(local_id, progress)` com status (`✅ done` / `🔄 wip` /
`🔴 blocked`), commits, data e notas de smoke. Isso é estado relacional da
linha, não uma lição de sessão — não use `save_observation` para isso.

Pule este passo em um módulo sem histórias. Não invente uma.

### 3. `set_project_state` — o passo pelo qual este comando existe

**Nunca pule.** Se for fazer uma coisa só aqui, faça esta.

Ele **substitui** o conteúdo anterior: escreva o quadro completo, não um
delta. Nesta ordem:

- onde o trabalho está agora;
- o que está **verificado** e o que não está (o número da suíte se você a
  rodou, "não rodada" se não);
- a próxima ação concreta;
- o que já está medido e resolvido, para não ser rediscutido.

Escreva como se a sessão terminasse aqui — porque pode terminar. É essa
suposição que faz valer a pena digitar o comando.

### 4. Recap, em quatro linhas ou menos

Os títulos que você salvou, uma linha sobre o que `set_project_state` diz
agora, e a oferta de reescrever qualquer um dos dois. Depois pare de falar
e volte ao trabalho.

---

## Usar antes de `/compact`

Este é o protocolo de pré-compactação. Rode `/jarbis-save` primeiro e
depois `/compact`. Tudo acima continua valendo, mais isto:

- No passo 1, adicione um `save_observation` com `kind: "discovery"` e
  `tags: "pre-compact"` com o snapshot estruturado: a linha de raciocínio
  aberta, as decisões já tomadas nesta sessão, os caminhos em jogo, e tudo
  o que você está segurando na cabeça e não está escrito em lugar nenhum.
- Erre para o lado do longo. Depois da compactação, essa nota e
  `project_state` é tudo o que sobra do raciocínio.

---

## Regras

- **Não chame `end_session`.** Isso é `/jarbis-close`. Se o usuário quer
  mesmo parar, diga isso e aponte para lá.
- **Não faça commit nem push.** Salvar é um ato de memória, não de git.
- **Não invente avanço.** Se pouco aconteceu desde o último salvamento, o
  estado diz que pouco aconteceu. Um checkpoint otimista é pior que
  nenhum, porque a próxima sessão acredita nele.
- **Não re-salve o que já foi salvo.** Veja o que esta sessão já escreveu
  antes de adicionar uma segunda nota sobre a mesma coisa; use
  `update_observation` para corrigir uma no lugar em vez de empilhar a
  correção ao lado.
- **Se não houver sessão aberta**, diga isso e escreva `set_project_state`
  mesmo assim — é a parte que sobrevive de qualquer jeito.
- Linguagem natural continua funcionando. "Salva isso", "atualiza tua
  memória", "anota isso antes que se perca" significam o mesmo. O comando
  só garante o piso.
