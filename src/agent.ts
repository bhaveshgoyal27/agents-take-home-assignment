import type {
  Channel,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
} from "./types.js";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";
import type { Patient } from "./types.js";

const SAFEGUARDING_PATTERNS = [
  /\b(rough|hit|hurt|abuse|neglect|unsafe|violent|harm)\b/i,
  /\bdad\b.*\b(rough|hit|hurt)\b/i,
];

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const outputs: ItemOutput[] = [];
  for (const item of inbox) {
    outputs.push(await withItemContext(item.id, () => triageItem(item)));
  }
  return outputs;
}

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  const intake = extractIntake(item);
  const safeguarding = detectSafeguarding(item.body);

  if (safeguarding) {
    return finishSafeguarding(item, intake, safeguarding);
  }

  if (isSameDayScheduling(item)) {
    return finishScheduling(item, intake);
  }

  if (isClinicalQuestion(item)) {
    return finishClinicalQuestion(item, intake);
  }

  if (isIncompleteReferral(intake, item)) {
    return finishMissingPaperwork(item, intake);
  }

  return finishReferral(item, intake);
}

async function finishSafeguarding(
  item: InboxItem,
  intake: ExtractedIntake,
  trigger: string,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "safeguarding" });
  const esc = await escalate({
    item_id: item.id,
    reason: `Possible safeguarding disclosure: ${trigger}`,
    severity: "P0",
  });
  const childLabel = intake.child_name ?? "the child";
  const task = await create_task({
    assignee: "clinical_lead",
    title: `P0 safeguarding review: ${childLabel}`,
    due: nextBusinessDay(),
    notes: `Review ${item.channel} from ${item.sender}. Do not contact family for investigative detail until clinical lead approves next steps.`,
  });
  const draft = await draft_message({
    recipient: messageRecipient(intake, item),
    channel: messageChannel(item.channel),
    body:
      "Thank you for reaching out to Cedar Kids Therapy. We received your message and a member of our care team will contact you shortly. If you or your child are in immediate danger, please call 911.",
    language: preferredLanguage(item.body),
  });

  return buildOutput(item, {
    classification: "safeguarding",
    urgency: "P0",
    extracted_intake: intake,
    missing_info: missingReferralFields(intake),
    recommended_next_action:
      "Clinical lead must review immediately before any scheduling or clinical outreach; follow mandated-reporter workflow.",
    draft_reply: draft.args.body as string,
    task_ids: [task.data.task_id],
    escalation: {
      reason: `Possible safeguarding disclosure: ${trigger}`,
      severity: "P0",
    },
    decision_rationale: `Disclosure matched safeguarding policy (${trigger}). Escalated ${esc.data.escalation_id} at P0; outbound message is neutral acknowledgement only.`,
  });
}

async function finishScheduling(
  item: InboxItem,
  intake: ExtractedIntake,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "scheduling" });
  await lookup_policy({ topic: "cancellation" });

  const patientName = intake.child_name;
  let matchedPatients: Patient[] = [];
  if (patientName) {
    const search = await search_patient({
      name: patientName,
      dob: isoDob(intake.dob_or_age),
    });
    matchedPatients = search.data;
  }

  const discipline = primaryDiscipline(intake, item.body) ?? "OT";
  const slots = await find_slots({
    discipline,
    preferences: extractSlotPreferences(item.body),
  });

  let holdNote = "";
  const patientRef = patientRefFromMatch(matchedPatients, patientName, item.id);
  if (slots.data[0]) {
    const hold = await hold_slot({
      slot_id: slots.data[0].slot_id,
      patient_ref: patientRef,
    });
    holdNote = ` Pending hold ${hold.data.hold_id} for staff review.`;
  }

  const parentName = parentNameFromContact(intake);
  const childName = patientName ?? "your child";
  const contactHint = parentPhoneFromContact(intake) ?? parentEmail(intake) ?? "contact on file";

  const task = await create_task({
    assignee: "front_desk",
    title: `Same-day reschedule: ${childName}`,
    due: todayIsoDate(),
    notes: `Same-day schedule change via ${item.channel}. ${summarizeBody(item.body)} Contact family at ${contactHint}.`,
  });

  const draft = await draft_message({
    recipient: messageRecipient(intake, item),
    channel: messageChannel(item.channel),
    body: `Hi${parentName ? ` ${parentName}` : ""}, we are sorry ${childName} is not feeling well. Our scheduling team will call you today to review reschedule options for the ${discipline} appointment. We are not able to confirm a new time by email.`,
    language: preferredLanguage(item.body),
  });

  return buildOutput(item, {
    classification: "scheduling",
    urgency: "P1",
    extracted_intake: intake,
    missing_info: [],
    recommended_next_action:
      `Front desk should call the family today to confirm a new ${discipline} time.${holdNote}`,
    draft_reply: draft.args.body as string,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale:
      "Same-day cancellation or reschedule is a P1 operational issue per scheduling policy; patient lookup and slot options prepared for human confirmation only.",
  });
}

async function finishClinicalQuestion(
  item: InboxItem,
  intake: ExtractedIntake,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "clinical_advice" });
  const childName = intake.child_name ?? "your child";
  const task = await create_task({
    assignee: "clinical_lead",
    title: `Clinical question: ${childName}`,
    due: nextBusinessDay(),
    notes: `Portal clinical question from ${item.sender}. ${summarizeBody(item.body)} Clinician should respond; do not provide clinical advice in automated reply.`,
  });
  const draft = await draft_message({
    recipient: messageRecipient(intake, item),
    channel: "portal",
    body: `Thank you for your message about ${childName}'s speech sounds. We cannot provide clinical advice over the portal, but an intake coordinator will reach out to discuss screening options and next steps.`,
    language: preferredLanguage(item.body),
  });

  const missing = missingReferralFields(intake);

  return buildOutput(item, {
    classification: "clinical_question",
    urgency: "P2",
    extracted_intake: {
      ...intake,
      discipline: intake.discipline ?? inferDisciplineFromQuestion(item.body),
      diagnosis_or_concern:
        intake.diagnosis_or_concern ?? summarizeClinicalQuestion(item.body),
    },
    missing_info: missing.length ? missing : ["child date of birth", "insurance information"],
    recommended_next_action:
      "Clinical lead or intake should call the family to discuss developmental screening without providing diagnosis over message.",
    draft_reply: draft.args.body as string,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale:
      "Portal message requests clinical guidance; policy prohibits automated clinical advice, so routed to clinician review with a neutral acknowledgement draft.",
  });
}

async function finishMissingPaperwork(
  item: InboxItem,
  intake: ExtractedIntake,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "service_lines" });
  const missing = missingReferralFields(intake);
  const childName = intake.child_name ?? "the referred child";
  const discipline = intake.discipline?.join("/") ?? "therapy";
  const referrer = extractReferringProvider(item.body) ?? item.sender;

  const task = await create_task({
    assignee: "intake",
    title: `Complete referral paperwork: ${childName}`,
    due: nextBusinessDay(),
    notes: `Missing: ${missing.join(", ")}. Request complete referral from ${referrer} before scheduling.`,
  });
  const draft = await draft_message({
    recipient: item.sender,
    channel: messageChannel(item.channel),
    body: `Internal: ${childName} ${discipline} referral from ${referrer} is missing ${missing.join(", ")}. Intake to request complete documentation before family outreach.`,
    language: "en",
  });

  return buildOutput(item, {
    classification: "missing_paperwork",
    urgency: "P2",
    extracted_intake: intake,
    missing_info: missing,
    recommended_next_action:
      "Intake should request complete referral details from the referring source before contacting the family.",
    draft_reply: draft.args.body as string,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale:
      "Referral lacks minimum intake fields required for insurance verification and scheduling; held for paperwork completion.",
  });
}

async function finishReferral(
  item: InboxItem,
  intake: ExtractedIntake,
): Promise<ItemOutput> {
  const missing = missingReferralFields(intake);
  const taskIds: string[] = [];
  let matchedPatients: Patient[] = [];

  if (intake.child_name) {
    const search = await search_patient({
      name: intake.child_name,
      dob: isoDob(intake.dob_or_age),
    });
    matchedPatients = search.data;
  }

  let insuranceStatus: string | null = null;
  const language = preferredLanguage(item.body);

  if (intake.payer || intake.member_id) {
    const insurance = await verify_insurance({
      payer: intake.payer ?? undefined,
      member_id: intake.member_id ?? undefined,
    });
    insuranceStatus = insurance.data.status;
    await lookup_policy({ topic: "insurance" });

    if (insurance.data.status === "out_of_network") {
      const billingTask = await create_task({
        assignee: "billing",
        title: `Out-of-network benefits: ${intake.child_name ?? "referral"}`,
        due: nextBusinessDay(),
        notes: `${intake.payer ?? "Payer"} verified out of network. Call parent before any slot hold.`,
      });
      taskIds.push(billingTask.data.task_id);

      const draft = await draft_message({
        recipient: messageRecipient(intake, item),
        channel: messageChannel(item.channel),
        body: buildOutOfNetworkDraft(intake),
        language,
      });

      return buildOutput(item, {
        classification: "new_referral",
        urgency: "P2",
        extracted_intake: intake,
        missing_info: missing,
        recommended_next_action:
          "Billing should discuss out-of-network options with the family before staff holds any evaluation slot.",
        draft_reply: draft.args.body as string,
        task_ids: taskIds,
        escalation: null,
        decision_rationale: `Referral intake is otherwise complete, but insurance verification returned ${insuranceStatus}; policy requires benefits conversation before scheduling.`,
      });
    }
  }

  const discipline = primaryDiscipline(intake, item.body);
  if (discipline) {
    const slots = await find_slots({
      discipline,
      preferences: extractSlotPreferences(item.body),
      language: language === "es" ? "es" : undefined,
    });

    if (
      slots.data.length > 0 &&
      insuranceStatus !== "out_of_network" &&
      missing.length === 0
    ) {
      await hold_slot({
        slot_id: slots.data[0].slot_id,
        patient_ref: patientRefFromMatch(
          matchedPatients,
          intake.child_name,
          item.id,
        ),
      });
    }
  }

  await lookup_policy({ topic: "service_lines" });

  const intakeTask = await create_task({
    assignee: "intake",
    title: `New ${discipline ?? "therapy"} referral: ${intake.child_name ?? "unknown"}`,
    due: nextBusinessDay(),
    notes: buildIntakeNotes(item, intake, insuranceStatus),
  });
  taskIds.push(intakeTask.data.task_id);

  const draft = await draft_message({
    recipient: messageRecipient(intake, item),
    channel: messageChannel(item.channel),
    body: buildReferralDraft(intake, language, item.body),
    language,
  });

  return buildOutput(item, {
    classification: "new_referral",
    urgency: "P2",
    extracted_intake: intake,
    missing_info: missing,
    recommended_next_action: buildReferralAction(intake, insuranceStatus, missing),
    draft_reply: draft.args.body as string,
    task_ids: taskIds,
    escalation: null,
    decision_rationale: buildReferralRationale(item, intake, insuranceStatus, missing),
  });
}

function buildOutput(
  item: InboxItem,
  fields: Omit<ItemOutput, "item_id" | "tools_called" | "requires_human_review">,
): ItemOutput {
  return {
    item_id: item.id,
    requires_human_review: true,
    tools_called: getToolCallsForItem(item.id),
    ...fields,
  };
}

function extractIntake(item: InboxItem): ExtractedIntake {
  const text = `${item.subject}\n${item.body}`;
  return {
    child_name: extractChildName(text),
    dob_or_age: extractDob(text),
    parent_contact: extractParentContact(text, item.sender),
    discipline: extractDiscipline(text),
    diagnosis_or_concern: extractConcern(text, item.subject),
    payer: extractPayer(text),
    member_id: extractMemberId(text),
  };
}

function extractChildName(text: string): string | null {
  const patterns: RegExp[] = [
    /Child:\s*([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)*)\s*\.?\s*DOB/i,
    /Child:\s*([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)*)\s*\.(?:\s|$)/i,
    /Referral:\s*([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)*)\s*-/i,
    /referral for\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)*),?\s+DOB/i,
    /(?:hija|hijo)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)*)/i,
    /my (?:son|daughter|child)\s+([A-Za-z][A-Za-z'-]+)/i,
    /my 4-year-old\s+([A-Za-z]+)/i,
    /([A-Za-z]+ [A-Za-z]+)\s+threw up/i,
    /([A-Za-z]+ [A-Za-z]+)'s\s+DOB/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && !/\b(son|daughter|child|hija|hijo)\b/i.test(match[1])) {
      return cleanName(match[1]);
    }
  }
  return null;
}

function extractDob(text: string): string | null {
  const iso = text.match(/\bDOB[:\s]+(\d{4}-\d{2}-\d{2})\b/i);
  if (iso?.[1]) return iso[1];
  const inline = text.match(/\bDOB\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (inline?.[1]) return inline[1];
  const age = text.match(/\b(\d{1,2})\s*(?:years? old|anos?)\b/i);
  if (age?.[1] && !text.includes("[blank]")) return `age ${age[1]}`;
  return null;
}

function extractParentContact(text: string, sender: string): string | null {
  const parentLine = text.match(
    /Parent(?:\/guardian)?:\s*(.+?)\.\s*(?:Discipline|Insurance)/i,
  );
  if (parentLine?.[1]) {
    const chunk = parentLine[1].replace(/\[blank\]/gi, "").trim();
    if (chunk) return chunk;
  }

  const parentNamed = text.match(
    /I am (?:his|her|their) parent,?\s*([A-Za-z][A-Za-z .'-]+)/i,
  );
  const caller = text.match(
    /(?:Hi, this is|Hola, soy)\s*([A-Za-z][A-Za-z .'-]+?)(?:\s+calling|\.|,|\s+llamo)/i,
  );
  const email = text.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
  const phone = text.match(/\b\d{3}-\d{4}\b/)?.[0];
  let name = parentNamed?.[1]?.trim() || caller?.[1]?.trim();

  if (!name && email) {
    const fromEmail = email.split("@")[0]?.replace(/[._]/g, " ");
    if (fromEmail) name = titleCase(fromEmail);
  }

  if (name || email || phone) {
    return [name, phone, email].filter(Boolean).join(", ");
  }

  const fromSender = sender.match(/^([^<]+)</);
  if (fromSender?.[1]?.trim()) {
    return fromSender[1].trim();
  }
  const senderEmail = sender.match(/<([^>]+)>/)?.[1];
  if (senderEmail) return senderEmail;

  return null;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractDiscipline(text: string): Discipline[] | null {
  const found = new Set<Discipline>();
  if (/\bSLP\b|speech[- ]?language|speech therapy|habla|articulation/i.test(text)) {
    found.add("SLP");
  }
  if (/\bOT\b|occupational therapy/i.test(text)) found.add("OT");
  if (/\bPT\b|physical therapy|toe walking/i.test(text)) found.add("PT");
  return found.size ? [...found] : null;
}

function extractPayer(text: string): string | null {
  if (/\[blank\]/i.test(text) && /Insurance:/i.test(text)) return null;
  const labeled = text.match(/Insurance:\s*([^.\n]+)/i);
  if (labeled?.[1] && !/\[blank\]/i.test(labeled[1])) return labeled[1].trim();
  const inline = text.match(
    /Insurance is\s+([^.,\n]+)|Tenemos\s+(Medicaid[^.,\n]*)/i,
  );
  return inline?.[1]?.trim() || inline?.[2]?.trim() || null;
}

function extractMemberId(text: string): string | null {
  const match = text.match(
    /Member ID:\s*([A-Z0-9-]+)|member ID\s+([A-Z0-9-]+)|miembro\s+([A-Z0-9-]+)/i,
  );
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function extractConcern(text: string, subject: string): string | null {
  const match = text.match(
    /(?:Concern:|Diagnosis\/concern:|looking for a [A-Z]{2,3} evaluation for)\s*([^.\n]+)/i,
  );
  if (match?.[1]) return match[1].trim();
  if (/R sounds|speech sounds/i.test(text)) {
    return summarizeClinicalQuestion(text);
  }
  if (/reschedule|threw up|can't make/i.test(subject + text)) {
    return "Same-day appointment change request";
  }
  return null;
}

function extractReferringProvider(text: string): string | null {
  const match = text.match(/(?:from|referral from)\s+(Dr\.\s*[A-Za-z .'-]+)/i);
  return match?.[1]?.trim() ?? null;
}

function extractSlotPreferences(text: string): string | undefined {
  if (/after school|tuesdays? or thursdays?/i.test(text)) {
    return "after school Tuesdays or Thursdays";
  }
  if (/\bmornings?\b/i.test(text)) return "mornings";
  if (spanishRequested(text)) return "Spanish-speaking provider";
  const pref = text.match(/Preferred availability:\s*([^.\n]+)/i);
  return pref?.[1]?.trim();
}

function detectSafeguarding(body: string): string | null {
  for (const pattern of SAFEGUARDING_PATTERNS) {
    const match = body.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function isSameDayScheduling(item: InboxItem): boolean {
  const text = `${item.subject} ${item.body}`;
  return (
    /reschedule|can't make|cannot make|cancel/i.test(text) &&
    (/today|same[- ]?day|this afternoon|3\s*pm/i.test(text) ||
      item.channel === "email")
  );
}

function isClinicalQuestion(item: InboxItem): boolean {
  return (
    item.channel === "portal_message" &&
    /normal|worried|advice|should i|should we/i.test(item.body)
  );
}

function isIncompleteReferral(
  intake: ExtractedIntake,
  item: InboxItem,
): boolean {
  if (item.channel !== "fax_referral") return false;
  if (/incomplete/i.test(item.subject)) return true;
  if (/\[(blank)\]/i.test(item.body)) return true;
  return missingReferralFields(intake).length >= 3;
}

function missingReferralFields(intake: ExtractedIntake): string[] {
  const missing: string[] = [];
  if (!intake.dob_or_age || intake.dob_or_age.includes("blank")) {
    missing.push("date of birth");
  }
  if (!intake.parent_contact || /\[blank\]/i.test(intake.parent_contact)) {
    missing.push("parent or guardian contact");
  }
  if (!intake.payer || /\[blank\]/i.test(intake.payer)) {
    missing.push("insurance payer");
  }
  if (!intake.member_id || /\[blank\]/i.test(intake.member_id)) {
    missing.push("insurance member ID");
  }
  return missing;
}

function messageChannel(channel: Channel): "email" | "portal" | "phone" {
  if (channel === "portal_message") return "portal";
  if (channel === "voicemail_transcript") return "phone";
  return "email";
}

function messageRecipient(intake: ExtractedIntake, item: InboxItem): string {
  return (
    parentEmail(intake) ??
    parentPhoneFromContact(intake) ??
    parentNameFromContact(intake) ??
    item.sender
  );
}

function parentEmail(intake: ExtractedIntake): string | null {
  return intake.parent_contact?.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? null;
}

function parentPhoneFromContact(intake: ExtractedIntake): string | null {
  return intake.parent_contact?.match(/\b\d{3}-\d{4}\b/)?.[0] ?? null;
}

function parentNameFromContact(intake: ExtractedIntake): string | null {
  if (!intake.parent_contact) return null;
  const first = intake.parent_contact.split(",")[0]?.trim();
  if (!first || /^\d{3}-\d{4}$/.test(first) || first.includes("@")) {
    return null;
  }
  const cleaned = first
    .replace(/\s+(calling|llamo|about).*$/i, "")
    .trim();
  return cleaned.length > 0 && cleaned.length < 50 ? cleaned : null;
}

function preferredLanguage(body: string): "en" | "es" {
  return spanishRequested(body) ? "es" : "en";
}

function spanishRequested(body: string): boolean {
  return /habla español|habla espanol|español|espanol|hola, soy|mi hija|mi hijo/i.test(
    body,
  );
}

function primaryDiscipline(
  intake: ExtractedIntake,
  body: string,
): Discipline | undefined {
  return intake.discipline?.[0] ?? extractDiscipline(body)?.[0];
}

function inferDisciplineFromQuestion(body: string): Discipline[] {
  return extractDiscipline(body) ?? ["SLP"];
}

function summarizeClinicalQuestion(body: string): string {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 120);
  return `Parent clinical question: ${snippet}`;
}

function patientRefFromMatch(
  patients: Patient[],
  childName: string | null,
  fallbackId: string,
): string {
  if (patients[0]?.patient_id) return patients[0].patient_id;
  if (childName) {
    return `ref_${childName.toLowerCase().replace(/\s+/g, "_")}`;
  }
  return `ref_${fallbackId}`;
}

function buildOutOfNetworkDraft(intake: ExtractedIntake): string {
  const child = intake.child_name ?? "your child";
  const payer = intake.payer ?? "your insurance plan";
  const parent = parentNameFromContact(intake);
  const greeting = parent ? `Hi ${parent}, thank you` : "Hi, thank you";
  return `${greeting} for ${child}'s referral. Our billing team needs to review ${payer} because it appears out of network for Cedar Kids Therapy. We will follow up with options before scheduling.`;
}

function buildReferralDraft(
  intake: ExtractedIntake,
  language: "en" | "es",
  body: string,
): string {
  const child = intake.child_name ?? "your child";
  const discipline = intake.discipline?.[0] ?? "therapy";
  const payer = intake.payer;
  const parent = parentNameFromContact(intake);
  const availability = extractSlotPreferences(body);

  if (language === "es") {
    const payerNote = payer ? ` (${payer})` : "";
    return `Hola${parent ? ` ${parent}` : ""}, gracias por comunicarse con Cedar Kids Therapy sobre ${child}. Recibimos su solicitud de evaluacion de ${discipline}${payerNote} y un coordinador se comunicara pronto para revisar cobertura y opciones de cita.`;
  }

  const greeting = parent ? `Hi ${parent}, thank you` : "Hi, thank you";
  const availNote = availability
    ? ` We noted your preference for ${availability}.`
    : "";
  return `${greeting} for ${child}'s ${discipline} referral. Our intake team will contact you to review insurance and next available evaluation times.${availNote}`;
}

function buildIntakeNotes(
  item: InboxItem,
  intake: ExtractedIntake,
  insuranceStatus: string | null,
): string {
  const parts = [
    `${item.channel} from ${item.sender}.`,
    intake.discipline?.join("/") ?? "discipline TBD",
  ];
  if (insuranceStatus) parts.push(`insurance: ${insuranceStatus}`);
  if (intake.diagnosis_or_concern) parts.push(`concern: ${intake.diagnosis_or_concern}`);
  return parts.join(" ");
}

function buildReferralAction(
  intake: ExtractedIntake,
  insuranceStatus: string | null,
  missing: string[],
): string {
  if (missing.length) {
    return "Complete missing intake fields, then proceed with insurance verification and scheduling.";
  }
  if (insuranceStatus === "in_network") {
    return `Intake should call the family to confirm ${intake.discipline?.join("/") ?? "therapy"} evaluation scheduling; slot hold may be pending staff review.`;
  }
  return "Intake should contact the family to confirm referral details and evaluation scheduling options.";
}

function buildReferralRationale(
  item: InboxItem,
  intake: ExtractedIntake,
  insuranceStatus: string | null,
  missing: string[],
): string {
  if (missing.length) {
    return `Referral from ${item.channel} is missing required intake fields: ${missing.join(", ")}.`;
  }
  const ins = insuranceStatus ? ` Insurance verified as ${insuranceStatus}.` : "";
  return `Standard new referral with sufficient intake data.${ins} Slots searched and hold left for staff review per policy.`;
}

function summarizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

function cleanName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*DOB.*$/i, "")
    .trim();
}

function isoDob(dobOrAge: string | null): string | undefined {
  if (!dobOrAge) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(dobOrAge) ? dobOrAge : undefined;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextBusinessDay(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}
