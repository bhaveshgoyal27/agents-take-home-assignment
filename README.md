# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

Rule-based triage agent for **Cedar Kids Therapy** that turns a weekend shared inbox into a human-reviewable action plan (classifications, urgency, tool audit trail, tasks, and draft replies).

## 1. How to run

Requires **Node.js LTS** and **npm**.

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Defaults match the flags above if omitted:

```bash
npm run triage
npm run validate
```

Optional checks:

```bash
npm run typecheck
```

**No API key is required.** The submitted agent is deterministic and rule-based. `ANTHROPIC_API_KEY` is only needed if you extend `src/agent.ts` to call Claude at runtime.

## 2. Stack and runtime


| Piece       | Choice                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| Language    | TypeScript (ES modules)                                                                 |
| Runtime     | Node.js LTS                                                                             |
| Runner      | `tsx`                                                                                   |
| Validation  | `ajv` + `schema/output.schema.json`                                                     |
| Agent style | Rule-based pipeline with regex intake extraction (no runtime LLM in the submitted path) |
| Build tool  | Cursor (implementation assist)                                                          |


End-to-end `npm run triage` on `data/inbox.json` (8 items) completes in **under one second** on a typical laptop.

## 3. Architecture

```
src/index.ts
  └─ configureTrace → runAgent(inbox) → buildBatchOutput → output.json

src/agent.ts
  └─ for each InboxItem:
       withItemContext(item.id)
         ├─ extractIntake (regex from subject/body/sender — no fixture IDs)
         ├─ route by message content:
         │    safeguarding keywords → P0 + escalate + clinical_lead task
         │    same-day reschedule/cancel → P1 + search_patient + slots/hold
         │    portal clinical question → policy + clinical_lead (no clinical advice in draft)
         │    incomplete fax (blanks / missing fields) → missing_paperwork + intake task
         │    default → referral path (insurance, slots, tasks, draft)
         └─ buildOutput → tools_called from getToolCallsForItem()

src/tools.ts (provided, unmodified)
  └─ mock EHR/billing/scheduling + JSONL audit trace
```

**Routing principles**

- **P0** only for safeguarding disclosures (e.g. rough treatment language).
- **P1** for same-day reschedule/cancellation signals in subject/body.
- **P2** default for intake, billing review, clinical questions, incomplete paperwork.
- **Out-of-network** (`verify_insurance` → `out_of_network`): billing task → no slot hold until benefits conversation.
- **In-network referrals**: verify insurance → `find_slots` (preferences from body text) → optional `hold_slot` using matched `patient_id` when found → intake task → `draft_message`.
- **Spanish drafts** when the message requests Spanish / uses Spanish phrasing (`preferredLanguage`).

Every item sets `requires_human_review: true`. Messages are **drafts only**; nothing is sent or scheduled automatically.

## 4. Failure modes and production eval


| Failure mode                       | Mitigation in prototype                                                     | Production eval idea                                     |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Missed safeguarding                | Keyword patterns + `lookup_policy(safeguarding)` + `escalate`               | Gold-set of harm disclosures; zero false negatives on P0 |
| Over-escalation (everything P0/P1) | Default P2; narrow P0/P1 triggers                                           | Precision/recall on urgency labels vs clinician review   |
| Bad intake extraction              | Structured regex for fax/email/voicemail; ISO DOB only for `search_patient` | Sampled human edit rate on `extracted_intake`            |
| Wrong insurance action             | Always `verify_insurance` before holds when payer present                   | Compare tool result to billing system of record          |
| Clinical advice in drafts          | Portal path uses neutral routing copy only                                  | LLM-judge or clinician rubric on `draft_reply`           |
| Trace/output mismatch              | `getToolCallsForItem` passed through unchanged                              | `npm run validate` in CI on every run                    |
| Hidden inbox variants              | Routing and tool args driven by message content, not fixture IDs            | Run validator + spot-check on held-out synthetic sets    |


**Regression gate:** `npm run validate` must pass (schema, 8/8 item coverage, summary counts, ≥3 distinct tools, trace ↔ output parity).

## 5. What I chose not to build, and why

- **Runtime LLM triage** : Time-boxed to a reliable rule pipeline that passes validation and encodes domain rules explicitly; easier to audit than a black-box prompt for this MVP.
- **Full NLP / PDF parsing** : Attachments are noted but not parsed; fax bodies are already text in the fixture.
- **Automatic appointment booking** : Assignment forbids scheduling; only `find_slots` / `hold_slot` for staff review.
- **Sending messages** : Only `draft_message`; families are never auto-contacted for safeguarding cases beyond a neutral ack draft.
- **Broad multi-language support** : Spanish drafts only when the message content indicates Spanish; other items stay English.
- **Persistent agent memory** : Each item is independent; sufficient for batch Monday triage.

## 6. What I would do with another 4 hours

1. **LLM assist for extraction only** : Claude on messy transcripts with JSON schema output, then keep tool orchestration rule-based.
2. **Stronger patient matching** : Fuzzy name + DOB + guardian phone before `search_patient`.
3. **Unit tests** : Extraction fixtures per channel; expected urgency/classification per inbox item.
4. **CI**: `typecheck` + `triage` + `validate` on push; fail if `output.json` drifts without regeneration.
5. **Reviewer dashboard** : Sort by P0→P3, show `tools_called` and one-click approve/edit draft.

---

## Assignment reference

### Scenario

Monday 8am at a pediatric therapy practice (SLP, OT, PT). The shared inbox has weekend fax referrals, voicemails, portal messages, and emails. Build a prototype that produces a sorted, human-reviewable plan.

### Rubric (summary)

- Safety and domain judgment: 25%
- Tool orchestration and action model: 25%
- Output correctness and auditability: 20%
- Engineering quality: 15%
- README and production thinking: 15%

### Urgency calibration

- **P0**: safeguarding / imminent harm — same-hour review
- **P1**: same-day operational (e.g. today’s appointment change)
- **P2**: normal intake, scheduling workflow, billing, clinical review
- **P3**: low-priority admin / FYI / spam

Default **P2** unless safety or same-day ops clearly apply.

### Constraints (honored)

- Agent in `src/agent.ts`; tools from `src/tools.ts` only
- `withItemContext` + `getToolCallsForItem` for audit trail
- `buildBatchOutput` via `src/index.ts`
- ≥3 distinct tools across the batch
- No auto-send, no auto-schedule

### Submit

Push to your GitHub repo and share the link. If private, grant `@nixu` access. Commit code, this README, and `output.json`.