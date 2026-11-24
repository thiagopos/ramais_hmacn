# DTI Gestão — ferramentas de inventário e monitoramento do hospital

Suíte de ferramentas do **DTI (Departamento de Tecnologia da Informação)** do
Hospital Municipal Alípio Corrêa Netto. Uma única aplicação web, com login pelo
Active Directory, reunindo o inventário de equipamentos de rede.

| Ferramenta | O que faz |
|---|---|
| **Telefones** | Descobre, identifica e monitora telefones IP (ALE) — ramal, modelo, firmware, estabilidade e histórico de quedas |
| **Impressoras** | Lê impressoras por SNMP — nível de toner, unidade de imagem, fusor, contadores de página e alerta de equipamento remanejado |

Em desenvolvimento: **Locais** (árvore de setores com hierarquia) e
**Analisador de Arquivos** (compartilhamentos do servidor).

---

## Sumário

- [Como funciona](#como-funciona)
- [Instalação e uso](#instalação-e-uso)
- [Interface web](#interface-web)
- [Banco de dados](#banco-de-dados)
- [Detalhes técnicos](#detalhes-técnicos)
- [Estrutura](#estrutura)
- [Rodando como serviço](#rodando-como-serviço)
- [Segurança](#segurança)

---

## Telefones: como funciona

Feita originalmente para telefones **Alcatel-Lucent Enterprise (ALE)**, com a
identificação (ramal, modelo, firmware, serial, MAC) obtida **sem login** via
SIP `OPTIONS` sobre TCP.

Quatro etapas, cada uma resolvendo um problema real de descoberta em rede:

### 1. Descoberta de hosts com **prova**

Um `TCP connect` tradicional é **inútil em redes com firewall/NAT** que responde
`SYN-ACK` em nome de qualquer IP. Um scan clássico nesse ambiente reporta hosts
que não existem (inclusive endereços de broadcast e redes inteiras não usadas).

A ferramenta exige prova de que o host **produz bits**:

- handshake TLS completo (com certificado do peer), ou
- resposta HTTP com linha de status válida.

Quem só faz `SYN-ACK` e fica mudo é descartado como *stub de firewall*.

### 2. Identificação pela cadeia de certificados

Telefones ALE usam certificado de fábrica cujo `CN` é o **MAC do aparelho**:

```
subject:  O=Aledevice, OU=PKI Authority, CN=3C28A6126D92
issuer:   O=ALE, OU=PKI Authority, CN=Aledevice Wired Phones
valid to: 2042
```

### 3. Ramal via SIP `OPTIONS` (sem autenticação)

A interface web do aparelho exige sessão para tudo. Porém o telefone responde
`OPTIONS` SIP sobre **TCP** na porta 5060, e o `200 OK` traz o AOR no `Contact`:

```http
SIP/2.0 200 OK
Contact: <sip:402025@10.0.0.2;transport=tls>       <-- RAMAL 402025
User-Agent: ALE H3G 2.15.10.000.3000 3c28a6126d92 NET241001985
```

Do `User-Agent` saem **modelo**, **firmware**, **MAC** e **serial**
(o serial só existe em firmwares mais novos).

> **UDP 5060 não responde** nesses aparelhos — obrigatório usar TCP.

### 4. Monitoramento amplo

A cada monitoramento o **range inteiro** é varrido (não apenas os IPs já
conhecidos), então:

- aparelhos **novos** entram no inventário automaticamente;
- aparelhos que **desapareceram** são marcados com data (`missing_since`) e
  geram evento no histórico.

O `OPTIONS` tem timeout curto (500 ms) e alta concorrência, porque o telefone
real responde em ~10 ms e o IP vazio simplesmente estoura o timeout. Um `/24`
completo leva menos de 1 segundo.

---

## Impressoras: como funciona

Leitura por **SNMP** (comunidade `public`), usando apenas os OIDs padrão da
MIB-II Printer (`1.3.6.1.2.1.43`). **Não existe lista de consumíveis por
modelo**: o nome vem da própria impressora.

| OID | O que traz |
|---|---|
| `43.5.1.1.16.1` | nome do modelo (`prtGeneralModelName`) |
| `43.5.1.1.17.1` | número de série |
| `43.10.2.1.4.1.1` | contador total de páginas |
| `43.11.1.1.6/8/9` | descrição, capacidade e nível de cada consumível |

Validado em cinco modelos reais (Samsung SL-M4020ND, HP 408dn, E52645, E57540 e
E87660 A3), somando **34 consumíveis** com nome, nível, capacidade e part number.

### Armadilhas do net-snmp encontradas em teste

- **`subtree()` derruba o processo.** Chamado mais de uma vez na mesma sessão,
  dispara `req.doneCb is not a function` e mata o Node. Por isso a coleta usa
  `get`, nunca `walk`.
- **Resposta grande não chega.** Um `get` com muitos OIDs estoura o datagrama e
  a impressora **simplesmente não responde** — parece desligada. As HP têm nomes
  longos; a coleta lê **um consumível por requisição**.

### Formatos diferentes entre fabricantes

| Situação | Tratamento |
|---|---|
| Mono reporta nível real (`3450` de `15000`) | percentual calculado |
| Colorida reporta porcentagem (`11` de `100`) | usado direto |
| Nível `-2` (indisponível na MIB) | não vira percentual negativo |
| Samsung devolve `IMP1757` como modelo | usa o `sysDescr` (`SL-M4020ND`) |
| Samsung devolve nome de painel (`Bucomaxilo`) | vai para **apelido**, não para modelo |

### Alerta de equipamento remanejado

O cadastro guarda a série esperada em cada IP (`serie_cadastro`); a coleta grava
a série lida (`serie`). Quando divergem, a impressora é marcada como
**série trocada**, e o sistema tenta descobrir **de onde veio** o aparelho
comparando a série lida com a esperada em todos os outros pontos.

Foi assim que apareceu uma rotação de três impressoras:

```
192.168.49.56 (UTI Adulto)      recebeu o aparelho de 192.168.49.48
192.168.49.48 (Centro Cirúrgico) recebeu o aparelho de 192.168.49.56
192.168.49.99 (Pediatria)        recebeu outro da mesma troca
```

Atenção: alguns firmware devolvem a série com **ponto final** (`ZDEJBQAJ800077Y.`).
A comparação ignora pontos, espaços e caixa para não gerar falso positivo.

### Peso do banco

O projeto anterior (`printers-snmp`) coletava a cada 30 minutos e **nunca
apagava**: 577 mil snapshots, 880 mil linhas de consumível e **149 MB** em nove
meses. Aqui o banco guarda o **estado atual** — a lista lê 103 linhas, não 880
mil. As tabelas de impressoras ocupam **0,07 MB**.

O histórico (para tendência) é opcional, em tabela separada, com **uma linha por
dia** em vez de uma por coleta.

---

## Instalação e uso

```bash
git clone https://github.com/<usuario>/<repo>.git
cd <repo>
npm install    # (não há dependências; só valida o package.json)
```

Requer Node >= 22.5 (`node:sqlite` nativo).

### Comandos

```bash
node src/index.js scan                    # varre a rede e grava no SQLite
node src/index.js scan --targets 10.0.0.0/24
node src/index.js enrich                  # descobre ramal/modelo/firmware via SIP
node src/index.js enrich --monitor        # um ciclo de monitoramento (varredura ampla)
node src/index.js ramais                  # lista ramal -> IP
node src/index.js web --port 8181         # interface web
node src/index.js report                  # inventário salvo
node src/index.js export --format csv --out telefones.csv
```

### Opções do `scan`

| Opção | Padrão | Descrição |
|---|---|---|
| `--targets` | ver `src/config.js` | alvos separados por vírgula (CIDR, range ou IP) |
| `--db` | `voip.sqlite` | caminho do banco |
| `--concurrency` | `64` | hosts simultâneos |
| `--timeout` | `800` | timeout TCP por porta (ms) |
| `--no-sip` | — | desativa o probe SIP |
| `--json` | — | salva o resultado também em JSON |

### Opções do `web`

| Opção | Padrão | Descrição |
|---|---|---|
| `--port` | `8080` | porta |
| `--host` | `127.0.0.1` | interface de escuta (`0.0.0.0` expõe na rede) |
| `--password` | — | obsoleto: a autenticação é pelo Active Directory |

---

## Interface web

Painel com:

- contadores: telefones, online, **desaparecidos**, com ramal;
- busca por ramal, IP, MAC, modelo, serial e firmware;
- filtro por status e ordenação por qualquer coluna;
- botão **Executar monitoramento** com feedback explícito de estado:

| Estado | Como aparece |
|---|---|
| em andamento | barra azul com spinner e cronômetro ao vivo; botão vira "Monitorando…" |
| concluído | barra verde com IPs varridos, online e duração |
| concluído com mudanças | barra amarela listando **ramais novos** ou que **desapareceram** |
| falhou | barra vermelha com motivo legível (servidor reiniciando, sessão expirada, erro interno) |

O estado é mantido no servidor (`/api/monitor/status`), então recarregar a página
durante a varredura mantém o acompanhamento. Clicar duas vezes não dispara duas
varreduras — o segundo clique recebe `409` e a UI mostra "já existe um em andamento".

- data do último monitoramento no cabeçalho;
- painel lateral com ficha técnica completa e histórico de disponibilidade.

### Autenticação (Active Directory)

O acesso é validado em **duas etapas independentes**:

1. o **AD prova quem é a pessoa** — bind LDAP com a senha que ela digitou
2. a tabela `usuarios` decide **se ela pode entrar** (lista fechada)

Quem autentica no domínio mas não está cadastrado recebe uma tela de acesso
negado. Quem está cadastrado mas foi desativado também.

```bash
cp .env.example .env    # preencha AD_SEARCH_USER e AD_SEARCH_PASSWORD
node scripts/semear-admin.mjs x344942
```

| Variável | Para que serve |
|---|---|
| `AD_URL` | DCs (espaço ou vírgula). Com vários, há failover automático |
| `AD_BASE_DN` / `AD_DOMAIN` | Base da busca e domínio do UPN |
| `AD_SEARCH_USER` / `AD_SEARCH_PASSWORD` | **Somente** busca na tela de cadastro |

Sobre a senha: ela existe apenas durante a requisição. O AD valida, o sistema
guarda só o token de sessão. **Nada de senha é gravado no banco.**

O login usa bind por **UPN** (`usuario@rede.sp`), sem fallback por DN: neste
diretório o DN carrega o nome completo e uma OU intermediária
(`CN=Fulano de Tal,OU=Users,OU=SMS,DC=rede,DC=sp`), impossível de montar a
partir do login.

### Sessão

Cookie `HttpOnly` + `SameSite=Lax` com um **token aleatório**; o dono da
sessão, o prazo (12 h) e a revogação vivem na tabela `sessoes`. Remover ou
desativar um usuário derruba o acesso dele na hora, sem esperar o cookie
expirar.

### HTTPS

A interface roda em **HTTPS na porta 8443** (e continua em HTTP na 8181, para
não quebrar endereços já em uso). A porta 443 desta máquina pertence ao sistema
de visitantes.

O certificado é o **mesmo das demais aplicações do hospital** (`certs/`): uma CA
local (`ca.crt`) mais um certificado de servidor assinado por ela. Não é
autoassinado de propósito — um certificado de CA usado como certificado de
servidor é recusado pelo Firefox (`MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY`),
embora o Chrome aceite. A estrutura de dois níveis evita essa diferença.

Máquinas que já têm a CA instalada (por qualquer aplicação do hospital) confiam
no VoIP automaticamente. Em máquina nova, rode
`certs/instalar-certificado.bat` como administrador.

```json
{
  "host": "0.0.0.0",
  "port": 8181,
  "ssl": { "cert": "certs/servidor.crt", "key": "certs/servidor.key", "port": 8443 }
}
```

Sem a seção `ssl`, o servidor sobe apenas em HTTP. As chaves privadas
(`*.key`) estão no `.gitignore`; a CA e o certificado público são versionados
para facilitar a instalação nas máquinas.

### Gráfico de disponibilidade

No painel lateral de cada aparelho, o histórico é montado **no relógio dos
ciclos** (1 hora). Para cada hora da janela, a barra mostra:

| Barra | Significado |
|---|---|
| verde | respondeu no ciclo |
| vermelha | estava no inventário mas não respondeu |
| cinza | **não houve coleta** naquela hora (servidor parado ou tarefa não rodou) |

Estados acima das barras, calculados sobre a janela escolhida:

- **Uptime** — % de ciclos em que respondeu (verde ≥99%, amarelo ≥90%, vermelho abaixo)
- **Quedas** — transições online → offline (conta o momento da queda, não cada hora parada)
- **Cobertura** — % de ciclos que efetivamente rodaram (amarelo se <95%)

Janelas: **24h**, **3 dias** e **7 dias**. Passar o mouse na barra mostra a
data/hora e o estado. Amostras são mantidas por **90 dias**.

---

## Banco de dados

SQLite via `node:sqlite`.

| Tabela | Conteúdo |
|---|---|
| `scans` | uma linha por execução (alvo, início/fim, totais) |
| `devices` | inventário: IP, **ramal**, MAC, modelo, **firmware**, **serial**, `online`, `missing_since` |
| `ports` | portas abertas por scan (histórico) |
| `sip_info` | respostas SIP coletadas |
| `events` | `new`, `disappeared`, `ramal_changed`, `ports_opened`, `ports_closed` |
| `monitor_runs` | ciclos de monitoramento |
| `monitor_samples` | uptime por IP por ciclo (retenção de 30 dias) |
| `device_stats` | **cache** das métricas de estabilidade (1 linha por IP) |
| `drop_episodes` | **cache** dos episódios de queda (caiu → voltou) |
| `meta` | `schema_version`, `stats_at` (última atualização do cache) |
| `v_phones` (view) | atalho para o inventário de telefones |
| `v_estabilidade` (view) | regra de estabilidade (window functions) |
| `v_quedas` (view) | regra dos episódios de queda |

**Impressoras**

| Tabela | Conteúdo |
|---|---|
| `impressoras` | IP, série lida, **série do cadastro**, modelo, apelido, setor, local, `local_id`, páginas |
| `impressora_consumiveis` | último estado de cada consumível (nome, nível, part number, serial) |
| `impressora_historico` | uma linha por impressora **por dia** (tendência) |

**Locais (setores e sublocais)**

| Tabela | Conteúdo |
|---|---|
| `locais` | nome, tipo, **`pai_id`** (opcional), andar, prédio, ala, origem |
| `local_ramais` | vínculo N:N ramal ↔ local |

**Usuários**

| Tabela | Conteúdo |
|---|---|
| `usuarios` | login do AD, nome, e-mail, `ativo` — lista fechada de quem pode entrar |
| `sessoes` | token de sessão, dono, expiração, IP |

### Hierarquia de locais

Um lugar = uma linha. Telefones e impressoras apontam para o **mesmo** registro,
em vez de cada um ter seu vocabulário de texto livre.

```sql
locais(id, nome, tipo, pai_id, andar, predio, ala, origem, ativo)
```

Regras de exclusão — todas testadas:

| Ação | O que acontece |
|---|---|
| Excluir um **pai** | os filhos **não** são apagados: perdem o vínculo e viram raiz |
| Excluir um local com **impressoras** | elas ficam **livres** (`local_id` NULL), não são apagadas |
| Excluir um local com **ramais** | o vínculo sai; o ramal continua existindo em `devices` |
| Criar sem pai | permitido — `pai_id` é opcional, sempre |
| Criar em ciclo | bloqueado (um local não pode virar filho do próprio descendente) |

A chave de unicidade é **nome + pai + andar**: "Coordenação de Enfermagem" existe
no 4º e no 5º andar como lugares distintos, e continua assim.

### Cache materializado

As views `v_estabilidade` e `v_quedas` agregam 100 mil+ amostras com window
functions e custam ~650 ms e ~500 ms **por avaliação**. Uma página da interface
disparava 6 avaliações — daí os ~4 s de carregamento.

O resultado é calculado **uma vez por ciclo de monitoramento** e gravado em
`device_stats` e `drop_episodes` (`refreshStats()`, em transação única). A
leitura passa a ser O(1) e não cresce com o histórico.

As views continuam sendo a **fonte única da regra**: o cache é populado com
`INSERT ... SELECT FROM v_...`. Se a regra mudar, só a view muda.

```bash
node scripts/rebuild-stats.mjs    # reconstrói o cache (migração/correção)
```

`SCHEMA_VERSION` (em `src/lib/db.js`) controla a migração: suba o número ao
alterar `migrate()` e o banco é atualizado na próxima abertura.

Consultas úteis:

```sql
-- inventário
SELECT ramal, ip, model, firmware, serial FROM v_phones ORDER BY CAST(ramal AS INTEGER);

-- quem desapareceu
SELECT ramal, ip, missing_since FROM devices WHERE is_phone=1 AND online=0;

-- estabilidade (leitura instantânea do cache)
SELECT d.ramal, s.quedas, s.pct_indisponivel FROM device_stats s
  JOIN devices d ON d.ip = s.ip WHERE s.em_instabilidade=1 ORDER BY s.pct_indisponivel DESC;

-- mudanças recentes
SELECT created_at, ip, event, detail FROM events ORDER BY id DESC LIMIT 20;
```

### Desempenho

`node scripts/bench.mjs <rótulo>` mede cada endpoint e o carregamento da página,
salvando em `benchmarks/<rótulo>.json`. Compare dois momentos com
`node scripts/bench.mjs --compare antes depois`.

Evolução medida com 101 mil amostras e 249 telefones:

| Etapa | Carregamento | `/api/stats` | `/api/phones` |
|---|---|---|---|
| Original | 5200 ms | 3998 ms | 716 ms (297 KB) |
| Cache materializado | 42 ms | 13 ms | 16 ms |
| + gzip / ETag / 304 | 44 ms | 14 ms | 19 ms (30 KB gzip) |
| + payload enxuto | 41 ms | 15 ms | 17 ms (119 KB / 9 KB gzip) |
| + conexão reaproveitada | **4 ms** | **1 ms** | **3 ms** |

Recarga com `If-None-Match` devolve **304 sem corpo**. `POST /api/monitor`
responde em 18 ms e roda em processo filho, então a varredura não bloqueia a
interface.

---

## Detalhes técnicos

### Estados de um aparelho

| Estado | Significado |
|---|---|
| `online` | respondeu SIP na última varredura |
| `desaparecido` | estava no inventário e não respondeu (`missing_since` preenchido) |
| `não verificado` | nunca passou por um monitoramento |

### Armadilhas encontradas em campo

Documentadas porque custaram tempo e podem reaparecer em outras redes:

1. **Firewall responde SYN em qualquer IP.** Scan por `TCP connect` gera 100% de
   falso positivo. Solução: exigir TLS/HTTP real.
2. **SIP via UDP não responde.** Só `OPTIONS` sobre TCP na 5060.
3. **Tarefa agendada do Windows não religa processo morto.** `RestartOnFailure`
   só cobre falhas de *início*. Solução: supervisor externo + watchdog.
4. **Serial depende do firmware.** Firmwares antigos não enviam o campo.

---

## Estrutura

```
config/
  ad.js               parametros do Active Directory (le .env)
src/
  index.js            CLI (scan / enrich / ramais / report / export / web)
  scan.js             orquestrador da varredura (4 fases)
  enrich.js           identidade SIP + monitoramento amplo
  config.js           portas, alvos padrao, fingerprints, expansao CIDR
  lib/
    sipid.js          SIP OPTIONS TCP -> ramal, modelo, firmware, MAC, serial
    verify.js         prova de host real (TLS/HTTP) + fingerprint de certificado
    sip.js            SIP OPTIONS (UDP/TCP)
    portscan.js       TCP probe + banner HTTP
    sweep.js          ARP, DNS reverso
    db.js             schema e persistencia SQLite
    pool.js           concorrencia limitada
    impressoras-snmp.js  leitura SNMP (consumiveis, serie, paginas)
    impressoras-schema.js tabelas do modulo de impressoras
    impressoras-db.js    consultas da lista de impressoras
    locais.js         setores/sublocais com hierarquia pai/filho
  web/
    server.js         servidor HTTP/HTTPS + API JSON
    auth.js           telas de login/negado, cookie e token de sessao
    ldap.js           bind no AD e busca de usuarios
    public/
      index.html      painel de telefones
      impressoras.html painel de impressoras
certs/
  ca.crt              CA local (instalar nas maquinas)
  servidor.crt/.key   certificado do servidor (HTTPS)
  instalar-certificado.bat
scripts/
  bench.mjs           benchmark reproduzivel (endpoints + carregamento)
  smoke.mjs           33 verificacoes de fumaca da API
  rebuild-stats.mjs   reconstroi o cache de estatisticas
  gerar-certificado.mjs  regenera o certificado para a maquina atual
  semear-admin.mjs    cadastra o primeiro usuario
  importar-impressoras.mjs  importa o cadastro do projeto antigo
  coletar-impressoras.mjs   coleta SNMP de todas as impressoras
  migrar-locais.mjs   migra setores para a tabela locais (tem --aplicar)
  supervisor.mjs      mantem o servidor no ar (relanca se cair)
  run-server.mjs      runner com log em arquivo e rotacao
  watchdog.cmd        relanca o supervisor se a porta estiver fora
start-server.cmd      atalho para subir o servidor
```

---

## Portabilidade

O projeto foi desenhado para rodar em **qualquer maquina da rede**, nao so na de
desenvolvimento:

- **nenhum IP ou hostname no codigo** — alvos e portas em `web-config.json`,
  AD no `.env`, impressoes em banco
- **certificado regeneravel** — `node scripts/gerar-certificado.mjs` detecta o
  nome e os IPs da maquina e reassina um certificado novo **reaproveitando a CA**
  (as maquinas que ja confiam nela nao precisam reinstalar nada)
- **banco unico e portatil** — `voip.sqlite`, sem servico externo
- opcoes: `--extra <ip|nome>` para incluir outro endereco, `--todos` para somar
  a lista existente, `--nova-ca` (exige reinstalar a CA em todas as maquinas)

---

## Rodando com PM2 (recomendado)

O `ecosystem.config.cjs` define três apps:

| App | Comportamento |
|---|---|
| `voip-web` | servidor web + API; `autorestart: true` (PM2 religa se cair) |
| `voip-monitor` | varredura de telefones (`enrich --monitor`); `autorestart: false` + `cron_restart: '*/15 * * * *'` — roda, termina e aguarda o próximo ciclo |
| `impressoras-monitor` | coleta SNMP das impressoras; `autorestart: false` + `cron_restart: '0 * * * *'` — 1x por hora, porque a leitura leva ~21s e o toner muda devagar |

> **Os dois monitores aparecem como `stopped` entre ciclos — isso é o esperado.**
> Com `autorestart: false`, o PM2 executa a tarefa, ela termina e fica parada
> até o horário do cron. Só `errored` indica problema.
>
> Para conferir se o agendamento está de fato rodando, não olhe o status:
> consulte a última execução.
>
> ```bash
> pm2 describe voip-monitor | grep "cron restart"     # o cron está armado?
> pm2 logs impressoras-monitor --lines 20             # a coleta rodou?
> ```

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2-startup install    # sobe no boot do Windows (só na primeira vez)
```

O `web-config.json` (porta e host) é lido pela CLI `web`, tanto no uso
direto quanto sob o PM2. As credenciais do AD ficam no `.env`.

> `voip-monitor` aparecer como `stopped` entre ciclos é o **esperado** — o PM2 o
> acorda no horário do cron. Só `errored` indica problema.

---

## Alternativa sem PM2 (Tarefas Agendadas)

O projeto ainda traz `scripts/supervisor.mjs`, `scripts/run-server.mjs` e
`scripts/watchdog.cmd` para quem não usa PM2.

> **Não use os dois caminhos ao mesmo tempo.** Em 13/11 eles rodaram juntos e
> criaram duas instâncias do servidor disputando a porta 8181 — o watchdog
> relançava o supervisor porque checava a porta, e não o processo.

Scripts prontos para Windows (tarefa agendada + supervisor + watchdog).

```powershell
# 1) tarefa que sobe o supervisor no logon
$node   = (Get-Command node).Source
$root   = (Get-Location).Path
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\scripts\supervisor.mjs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "VoIP Monitor Web" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force

# 2) watchdog a cada 5 min (relança se a porta cair)
$act2 = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument "/c `"$root\scripts\watchdog.cmd`"" -WorkingDirectory $root
$trig = @(
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 999))
)
Register-ScheduledTask -TaskName "VoIP Monitor Watchdog" -Action $act2 -Trigger $trig -Principal $principal -Settings $settings -Force

# 3) varredura automatica de 1 em 1 hora
$act3 = New-ScheduledTaskAction -Execute $node -Argument "`"$root\src\index.js`" enrich --monitor" -WorkingDirectory $root
$trig3 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 999)
$set3 = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "VoIP Monitor Hourly" -Action $act3 -Trigger $trig3 -Principal $principal -Settings $set3 -Force
```

Arquitetura de resiliência:

```
Tarefa "VoIP Monitor Web"       -> supervisor no logon
  supervisor.mjs                -> relança o servidor em ~2s se ele morrer
    run-server.mjs              -> log em arquivo, rotação, retry interno
Tarefa "VoIP Monitor Watchdog"  -> a cada 5 min, relança o supervisor se a porta cair
Tarefa "VoIP Monitor Hourly"    -> varredura ampla de 1 em 1 hora
```

`StartWhenAvailable` faz a coleta atrasada rodar assim que a máquina voltar
(útil se o PC estiver desligado na hora marcada). Com isso a varredura roda
também sem ninguém clicar no botão do painel.

---

## Segurança

- **Credenciais de fábrica foram testadas e não funcionam** em ambientes
  provisionados por PBX — o provisionamento troca a senha. Não há ganho em
  manter credenciais conhecidas no código.
- A ferramenta **não faz força bruta** nem contorna autenticação: a identidade
  vem de respostas SIP públicas do próprio protocolo.
- A interface web **exige login** (Active Directory + lista de usuários).
  Sem `AD_SEARCH_USER`/`AD_SEARCH_PASSWORD` no `.env`, só a busca do cadastro
  fica indisponível — o login continua funcionando.
- O inventário revela ramal, MAC, IP e modelo — trate o `voip.sqlite` como
  **dado sensível** (já está no `.gitignore`).
- O `.env` guarda as credenciais de busca do AD e também está no `.gitignore`.

---

## Licença

MIT
