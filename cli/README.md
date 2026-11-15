# wishluck-ops

Terminal client for the **Wishluck order-ops & customer-support agent**. Chat as a customer, work the support inbox, create signed test orders, fire courier events and watch everything live — all from your shell.

It talks to a running Wishluck Ops backend over HTTP (the same API the dashboard uses), so it works against a local, Docker or deployed server. No dependencies; Node 18.17+.

```bash
npx wishluck-ops help            # one-off
npm i -g wishluck-ops            # installs two commands: wl and wishluck-ops
WL_URL=https://ops.example.com wl inbox
```

## Commands

| | |
|---|---|
| **Customer** | |
| `wl chat [--id <conv>]` | Interactive chat as a customer. Type `1`–`9` to tap the buttons the bot offers (Confirm order, Reschedule delivery, Yes/No…). Proactive COD/NDR messages and human replies show up live. `/new`, `/id`, `/quit`. |
| `wl say "<text>" [--id <conv>]` | Send one message, print the reply. |
| **Support team** | |
| `wl inbox [--status needs_human]` | Conversations, handovers first. |
| `wl show <conv> [--tools]` | Transcript, every tool call (`--tools` prints inputs/outputs), the handover ticket and suggested reply. |
| `wl takeover <conv>` · `wl reply <conv> "<text>"` · `wl reply <conv> --suggested` · `wl handback <conv>` · `wl resolve <conv>` | Act as a support agent. |
| `wl tickets [--all]` | Handover tickets. |
| `wl watch` | Live feed: messages, handovers, order changes. |
| **Orders & testing** | |
| `wl orders [--view cod\|awaiting\|hold\|high\|ndr\|rto]` | Orders with COD confirmation, risk score and failed attempts. |
| `wl order <id> [--audit]` | Items, risk reasons, courier timeline, returns, notes, audit log. |
| `wl new-order [high_risk\|low_risk\|repeat_refuser\|prepaid] [--dup]` | Create an order through the HMAC-signed webhook (`--dup` sends it twice to show idempotency). |
| `wl courier <order> <status> [--reason "…"] [--dup]` | Mock courier sends a signed status webhook (`delivery_failed`, `delivered`, …). |
| `wl action <order> <confirm\|cancel\|resend_confirmation\|release_hold\|note>` | Ops actions. |
| `wl jobs [--run]` | Queue state; `--run` fast-forwards reminders, holds and follow-ups. |
| **System** | |
| `wl stats` | Analytics: AI resolution rate, COD confirmation rate, RTO saves, handovers, LLM cost. |
| `wl settings [key=value …] [--fast\|--prod]` | Read or change settings, e.g. `wl settings risk.highThreshold=55 agent.llmEnabled=false`. |
| `wl health` · `wl reset --yes` | Server status · re-seed demo data. |

Conversation ids can be shortened to their last characters (as shown by `wl inbox`) or given as an order id.

**Environment:** `WL_URL` (default `http://localhost:4000`), `DASHBOARD_TOKEN` (if the server requires one), `NO_COLOR`.

## A 60-second tour

```bash
wl settings --fast                        # reminders in seconds instead of hours
wl new-order high_risk                    # ₹4,600 COD, "near Shiv mandir" → risk 80 (high)
wl chat --id WL10300                      # you are the customer; press 4 → pay online, 5% off
wl courier WL10236 delivery_failed --reason "Customer not available"
wl say "This is the third time! I'll file a consumer court case. WL10235 9845044004"
wl tickets && wl reply <id> --suggested   # answer as the support team
wl stats
```

MIT licensed.
