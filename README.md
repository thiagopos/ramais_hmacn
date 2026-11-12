# VoIP Scanner — inventário e monitoramento de telefones IP

Ferramenta em Node.js para **descobrir, identificar e monitorar** telefones IP em
rede, com persistência em SQLite e interface web.

Feita originalmente para telefones **Alcatel-Lucent Enterprise (ALE)**, com a
identificação (ramal, modelo, firmware, serial, MAC) obtida **sem login** via
SIP `OPTIONS` sobre TCP.

Zero dependências: usa apenas módulos nativos do Node (`net`, `tls`, `dgram`,
`http`, `node:sqlite`). Requer **Node >= 22.5**.

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

## Como funciona

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
| `--password` | de `web-config.json` | senha da tela de login |

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

### Configuração

Copie o exemplo e ajuste:

```bash
cp web-config.example.json web-config.json
```

```json
{
  "host": "127.0.0.1",
  "port": 8181,
  "password": "escolha-uma-senha"
}
```

> `web-config.json` está no `.gitignore` — a senha não vai para o repositório.

Sessão por cookie `HttpOnly` (12 h), senha comparada com SHA-256 em tempo
constante.

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
| `v_phones` (view) | atalho para o inventário de telefones |

Consultas úteis:

```sql
-- inventário
SELECT ramal, ip, model, firmware, serial FROM v_phones ORDER BY CAST(ramal AS INTEGER);

-- quem desapareceu
SELECT ramal, ip, missing_since FROM devices WHERE is_phone=1 AND online=0;

-- mudanças recentes
SELECT created_at, ip, event, detail FROM events ORDER BY id DESC LIMIT 20;
```

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
src/
  index.js          CLI (scan / enrich / ramais / report / export / web)
  scan.js           orquestrador da varredura (4 fases)
  enrich.js         identidade SIP + monitoramento amplo
  config.js         portas, alvos padrão, fingerprints, expansão CIDR
  lib/
    sipid.js        SIP OPTIONS TCP -> ramal, modelo, firmware, MAC, serial
    verify.js       prova de host real (TLS/HTTP) + fingerprint de certificado
    sip.js          SIP OPTIONS (UDP/TCP)
    portscan.js     TCP probe + banner HTTP
    sweep.js        ARP, DNS reverso
    db.js           schema e persistência SQLite
    pool.js         concorrência limitada
  web/
    server.js       servidor HTTP + API JSON
    auth.js         tela de login + sessão por cookie
    public/index.html  painel de monitoramento
scripts/
  supervisor.mjs    mantém o servidor no ar (relança se cair)
  run-server.mjs    runner com log em arquivo e rotação
  watchdog.cmd      relança o supervisor se a porta estiver fora
start-server.cmd    atalho para subir o servidor
```

---

## Rodando como serviço

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
```

Arquitetura de resiliência:

```
Tarefa "VoIP Monitor Web"       -> supervisor no logon
  supervisor.mjs                -> relança o servidor em ~2s se ele morrer
    run-server.mjs              -> log em arquivo, rotação, retry interno
Tarefa "VoIP Monitor Watchdog"  -> a cada 5 min, relança o supervisor se a porta cair
```

---

## Segurança

- **Credenciais de fábrica foram testadas e não funcionam** em ambientes
  provisionados por PBX — o provisionamento troca a senha. Não há ganho em
  manter credenciais conhecidas no código.
- A ferramenta **não faz força bruta** nem contorna autenticação: a identidade
  vem de respostas SIP públicas do próprio protocolo.
- A interface web **exige senha**. Sem senha configurada, só escute em
  `127.0.0.1`.
- O inventário revela ramal, MAC, IP e modelo — trate o `voip.sqlite` como
  **dado sensível** (já está no `.gitignore`).
- Use uma senha forte em `web-config.json`.

---

## Licença

MIT
