#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_DATE = '2026-09-30';
export const ABEL = Object.freeze({
  id: 'nike:employee:abel', employeeId: 'EMP-001', name: 'Abel',
  email: 'abel@nike.example', teamsUserId: 'nike:teams:abel',
  oldAddress: '14 Lantern Lane, 1000 Brussels (synthetic)',
  newAddress: '82 Meadow Crescent, 3000 Leuven (synthetic)',
  moveEffectiveDate: '2026-09-20',
});

const employeeNames = [
  'Abel', 'Sarah Van Doren', 'Milan De Ruyter', 'Noor Janssen', 'Louis Verstraeten',
  'Emma Vandenberg', 'Youssef Benali', 'Lotte Claessen', 'Arthur Maes', 'Elise Laurent',
  'Nora De Smet', 'Simon Dubois', 'Amina El Idrissi', 'Theo Willems', 'Jade Van Acker',
  'Oscar Leclerc', 'Lina Declercq', 'Elias Moreau', 'Mila Wouters', 'Adam Verbeek',
  'Sofia Vermeer', 'Victor Peeters', 'Ines Martens', 'Lucas Delcourt', 'Aya Van Hove',
  'Finn De Clercq', 'Zoe Lambert', 'Rayan Deschamps', 'Louise Van Damme', 'Basile Jacobs',
  'Iris De Wilde', 'Nolan Lefevre', 'Hana Bosmans', 'Leon Van den Berg', 'Maya Dupont',
  'Samir Goossens', 'Sofia Peeters', 'Felix Renard', 'Yara De Vos', 'Hugo Mertens',
  'Clara Van Loon', 'Ibrahim Aerts', 'Nina De Baets', 'Thomas Simonet', 'Sara Van Es',
  'Mathis Dierckx', 'Amelie Rousseau', 'Liam Verhoeven', 'Dalia Vercammen', 'Anton De Meyer',
];
const streets = ['Cedar Walk', 'Willow Square', 'Maple Terrace', 'Birch Avenue', 'Juniper Lane'];
const cities = ['1000 Brussels', '3000 Leuven', '9000 Ghent', '2000 Antwerp', '3500 Hasselt'];
const departments = ['Retail operations', 'People services', 'Store support', 'Merchandising', 'Logistics'];

function slug(name) { return name.toLowerCase().replaceAll(' ', '-'); }
export function employees() {
  return employeeNames.map((name, index) => {
    const employeeSlug = slug(name);
    const employeeId = `EMP-${String(index + 1).padStart(3, '0')}`;
    const commute = index === 0 ? 5 : 3 + (index * 7) % 18;
    return {
      id: `nike:employee:${employeeSlug}`, employeeId, name,
      email: `${employeeSlug.replaceAll('-', '.')}@nike.example`,
      teamsUserId: `nike:teams:${employeeSlug}`,
      address: index === 0 ? ABEL.oldAddress : `${20 + index * 3} ${streets[index % 5]}, ${cities[index % 5]} (synthetic)`,
      baseSalary: index === 0 ? 1800 : 1850 + (index % 12) * 75,
      bicycleCompensation: commute < 10 ? 50 : 80, commute,
      department: departments[index % 5],
      location: cities[index % 5].replace(/^\d+ /, ''),
      snapshotDate: '2026-09-01',
      employmentStartDate: `${2021 + index % 4}-${String(1 + index % 12).padStart(2, '0')}-01`,
      dossierPath: `sharepoint/employee-${employeeId}-${employeeSlug}.pdf`,
    };
  });
}

function pdfEscape(value) {
  if (/[^\x20-\x7e]/.test(value)) throw new Error(`PDF text must be printable ASCII: ${value}`);
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

// A small, uncompressed PDF 1.4 writer: built-in fonts, fixed layout, no clock,
// random identifiers or external dependencies. Ordinary PDF parsers extract text.
export function textPdf({ title, subtitle, lines, reference }) {
  const commands = ['0.12 0.25 0.32 rg', '0 830 595 12 re f'];
  const text = (value, x, y, size = 11, bold = false, color = '0.15 0.19 0.22') => {
    commands.push(`${color} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(value)}) Tj ET`);
  };
  text('NIKE BELGIUM / SYNTHETIC FIXTURE', 48, 788, 10, true, '0.12 0.35 0.43');
  text(title, 48, 747, 22, true);
  text(subtitle, 48, 721, 10);
  commands.push('0.76 0.81 0.83 RG 0.7 w 48 701 m 547 701 l S');
  let y = 668;
  for (const line of lines) {
    const row = typeof line === 'string' ? { text: line } : line;
    // A conservative line budget avoids accidental overflow from new fixtures.
    if (row.text.length > 91 || y < 170) throw new Error(`PDF row exceeds layout budget: ${row.text}`);
    text(row.text, 48, y, row.size ?? 11, row.bold ?? false);
    y -= row.gap ?? 24;
  }
  commands.push('0.76 0.81 0.83 RG 0.7 w 48 130 m 547 130 l S');
  text('Fictional people, amounts and addresses. Created for the TunnelVision POC.', 48, 110, 9);
  text(reference, 48, 94, 9);
  text('1 / 1', 523, 94, 9);
  const stream = `${commands.join('\n')}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'ascii');
}

export function dossierLines(employee) {
  return [
    `Employee ID: ${employee.employeeId}`, `Entity ID: ${employee.id}`,
    `Name: ${employee.name}`, `Email: ${employee.email}`, `Teams user ID: ${employee.teamsUserId}`,
    'Employer: Nike Belgium', `Department: ${employee.department}`, `Location: ${employee.location}`,
    `Address: ${employee.address}`, `Base salary: EUR ${employee.baseSalary} / month`,
    `Bicycle compensation: EUR ${employee.bicycleCompensation} / month`,
    `Bicycle commute one-way: ${employee.commute} km`, `Snapshot date: ${employee.snapshotDate}`,
    `Employment start date: ${employee.employmentStartDate}`,
    { text: 'Administrative snapshot prepared for SD Worx servicing Nike Belgium.', size: 10, gap: 20 },
    { text: 'This document records the dossier at the snapshot date.', size: 10 },
  ];
}

export const POLICY_PATH = 'sharepoint/mobility-policy-2026-09.pdf';
export const MOVE_PATH = 'gmail/2026-09-21-abel-address-change.txt';
export const HR_PATH = 'teams/hr-payroll-september.json';
export const POLICY_LINES = [
  'Policy title: Nike Belgium synthetic bicycle mobility policy',
  'Policy ID: nike-mobility-2026-09', 'Effective date: 2026-09-01',
  { text: 'Monthly bicycle compensation bands', bold: true, gap: 30 },
  { text: 'One-way bicycle commute              | Monthly compensation', bold: true },
  '0-9.9 km                              | EUR 50 / month',
  '>=10 km                               | EUR 80 / month',
  '',
  'Distance basis: regular one-way bicycle commute from home to work.',
  'Eligibility: employee regularly commutes by bicycle.',
  'Administration: changed distance is reviewed after an employee notification.',
  'Processing: HR passes verified dossier changes to the payroll service team.',
  '',
  { text: 'Synthetic POC policy only; not a real Nike or SD Worx policy.', size: 10 },
  { text: 'This policy contains no individual employee case or payroll decision.', size: 10 },
];

function email({ from, to = 'Sarah Van Doren <sarah.van.doren@nike.example>', date, id, subject, employeeId, body }) {
  return [
    `From: ${from}`, `To: ${to}`, `Date: ${date}`, `Message-ID: <${id}@nike.example>`,
    `Subject: ${subject}`, ...(employeeId ? [`Employee-ID: ${employeeId}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].join('\n');
}

const emailNoise = [
  ['Training room booking', 'Could we use the small meeting room for Thursday product training? The stock team expects eight attendees.'],
  ['Store opening checklist', 'The opening checklist is in the shared folder. Please confirm who can bring the spare display labels.'],
  ['September volunteering afternoon', 'I can join the volunteering afternoon after the morning briefing. Please add my name to the headcount.'],
  ['Access badge collection', 'My replacement access badge is ready at reception. I will collect it during the next office visit.'],
  ['Product photography schedule', 'The sample rack is ready for photography. Can the studio reserve thirty minutes after lunch?'],
  ['Stockroom label order', 'We need one box of medium shelf labels and two rolls for the packing desk. I have attached the internal item numbers in the shared order sheet.'],
  ['Safety briefing slides', 'I have added the emergency-exit diagram to the briefing slides. Could a colleague check the room names before we print them?'],
  ['Coffee machine maintenance', 'Facilities will service the coffee machine on Friday morning. The break area upstairs will remain available.'],
  ['Customer return packaging', 'The reusable packaging samples arrived today. We can compare them in the next store-support meeting.'],
  ['Delivery window confirmation', 'The supplier confirmed the morning delivery window. I will ask the receiving team to keep one trolley free.'],
  ['Learning session registration', 'Please reserve one place for me in the product-knowledge learning session. The late-morning slot works best.'],
  ['Printer toner received', 'The toner order has arrived. I placed the spare cartridges in the stationery cupboard next to the reception desk.'],
  ['Display fixture measurements', 'The revised display fits in the front bay. I will bring the measurements to the merchandising review.'],
  ['Team lunch headcount', 'I will join the team lunch and would like a vegetarian option. Please count me in for the final booking.'],
  ['Warehouse visitor list', 'The visitor list is ready for the warehouse tour. We are still waiting for one external attendee to confirm.'],
  ['Quiet room signage', 'The new quiet-room signs use the agreed wording. Could we put them up after the all-hands session?'],
  ['Presentation clicker found', 'I found the presentation clicker in the training room. It is now with reception in a labelled envelope.'],
  ['Retail feedback notes', 'The store feedback notes cover the sample wall and queue signage. There are no urgent requests for this week.'],
  ['Refreshments for workshop', 'The workshop needs water, fruit and paper cups. I can collect the order from reception before the first break.'],
  ['Sample inventory review', 'The sample inventory sheet has been checked against the rack. Two labels need replacing; all boxes are accounted for.'],
  ['Desk booking reminder', 'I have booked a desk near the training area for Tuesday. Please let me know if that section is needed for the workshop.'],
  ['Recycling collection', 'The recycling collection is scheduled for the afternoon. Please leave flattened cartons beside the loading-area container.'],
  ['Internal newsletter draft', 'The newsletter draft includes the volunteering photos and training calendar. I will send the final copy after the editor checks it.'],
  ['AV equipment check', 'The projector and microphones worked during the equipment check. The spare battery pack is in the meeting-room drawer.'],
  ['Store-support rota review', 'The proposed support rota covers the showroom visit. Could everyone confirm the meeting time in the calendar invitation?'],
];

const hrNoise = [
  'The induction packs for the new intake are ready at reception.',
  'The payroll calendar reminder has been pinned in this channel.',
  'Please use the shared training calendar when booking a workshop room.',
  'The benefits Q&A will start at 11:00 in the small meeting room.',
  'I uploaded the attendance sheet for the first-aid briefing.',
  'The onboarding checklist needs the emergency-contact form before sign-off.',
  'The visitor badges are in a labelled tray for tomorrow.',
  'The internal newsletter draft is available for spelling corrections.',
  'The monthly people-services huddle is now in the shared calendar.',
  'Please send lunch preferences for the training session before Thursday.',
  'The reception desk has the updated room-booking sheet.',
  'The product-learning session has two spare seats this week.',
  'I have put the workshop handouts in the training-room cupboard.',
  'The volunteering headcount is ready for the organiser.',
  'Reminder: the all-hands starts five minutes earlier on Friday.',
  'The new stationery order arrived; the sign-in sheets are replenished.',
  'The health-and-safety poster is on the noticeboard by the staff entrance.',
  'The staff survey closes at the end of the week.',
  'The HR office hours are listed on the intranet calendar.',
  'Thanks for checking the induction-room projector this morning.',
  'The meeting-room signs are ready for collection from reception.',
  'Please return the spare badge lanyards to the front desk.',
  'The September workshop photo album is in the shared team folder.',
  'I have reserved the quiet room for the learning session.',
];
const retailNoise = [
  'The window-display samples are ready for the morning review.',
  'Delivery confirmed for the first unloading slot tomorrow.',
  'Please leave the sample trolley next to the labelled rack.',
  'The new shelf labels are printed and sorted by bay.',
  'The front-bay layout is ready for the visual-merchandising check.',
  'The scanner charging station has been moved beside the packing desk.',
  'The team briefing notes are pinned above the shift board.',
  'Two reusable packaging samples are available in the stockroom.',
  'The returns desk has enough cartons for the afternoon collection.',
  'I checked the visitor route; the demo rack is accessible.',
  'The photography samples are on the blue trolley.',
  'Please use the loading-area recycling container for flattened cartons.',
  'The product-training handouts are on the meeting table.',
  'The spare label printer is back at the stockroom desk.',
  'The showroom visit agenda has been sent to the support team.',
  'The display measurements have been added to the shared worksheet.',
  'The receiving team can use the second trolley after the first delivery.',
  'The customer-feedback notes are ready for the weekly review.',
  'The catalogue samples have been returned to the storage bay.',
  'The last workshop room check is complete; the projector works.',
];
const benefitNoise = [
  'The lunch-and-learn calendar is ready for October bookings.',
  'The wellness workshop will use the small meeting room.',
  'The volunteering photos are ready for the newsletter editor.',
  'I registered for the product-learning session.',
  'The quiet-room booking sheet is at reception.',
  'There are still seats available at the first-aid briefing.',
  'The fruit order for the workshop has been confirmed.',
  'I will bring the spare projector cable to the learning session.',
  'The staff survey link is pinned in this channel.',
  'The training calendar now shows the room numbers.',
  'The induction welcome cards are ready to sign.',
  'The team lunch venue has confirmed the headcount.',
  'The book-swap shelf has space for more donations.',
  'Please leave the workshop name cards beside the sign-in sheet.',
  'The coffee machine is working after the facilities visit.',
  'I have returned the spare meeting-room microphone.',
];

function message(employee, id, createdDateTime, content, extra = {}) {
  return {
    id, createdDateTime,
    from: { id: employee.teamsUserId, displayName: employee.name, email: employee.email },
    employeeId: employee.employeeId,
    body: { contentType: 'text', content }, ...extra,
  };
}
function noiseMessages(roster, channel, content, startDay, employeeOffset) {
  return content.map((body, index) => message(
    roster[(index * 3 + employeeOffset) % roster.length],
    `nike-teams-${channel}-noise-${String(index + 1).padStart(3, '0')}`,
    `2026-09-${String(startDay + Math.floor(index / 2)).padStart(2, '0')}T${index % 2 ? '14' : '09'}:15:00Z`, body,
  ));
}
export function teamsExports(roster = employees()) {
  const hr = roster[1];
  const abelMention = [{ id: ABEL.teamsUserId, displayName: 'Abel', email: ABEL.email }];
  const abelFields = { employeeId: ABEL.employeeId, mentions: abelMention };
  const relevant = [
    message(hr, 'nike-teams-abel-ack-20260922', '2026-09-22T08:40:00Z',
      `Hi Abel, thanks for your email. I acknowledge your address change effective 2026-09-20. Your new address is ${ABEL.newAddress}.`, abelFields),
    message(hr, 'nike-teams-abel-commitment-20260922', '2026-09-22T08:43:00Z',
      'I will update Abel\'s dossier and pass the address and bicycle-commute change to SD Worx ahead of the September payroll handover.', abelFields),
    {
      id: 'nike-teams-abel-followup-20260928', createdDateTime: '2026-09-28T10:20:00Z',
      from: { id: 'sdworx:teams:lea-marchal', displayName: 'Lea Marchal', email: 'lea.marchal@sdworx.example' },
      ...abelFields,
      body: { contentType: 'text', content: `While checking Abel (EMP-001) for September payroll, the dossier still shows ${ABEL.oldAddress} and bicycle compensation EUR 50 per month. I cannot find confirmation that HR's address and commute change reached payroll; it appears not processed. Could you check? This follow-up is open; no corrected calculation has been confirmed.` },
    },
    message(hr, 'nike-teams-abel-still-open-20260928', '2026-09-28T11:05:00Z',
      'I have not yet found confirmation that Abel\'s update was carried through. I am checking the handover list. The issue remains open pending confirmation from payroll.', abelFields),
  ];
  const chronological = messages => messages.sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime) || a.id.localeCompare(b.id));
  return new Map([
    [HR_PATH, {
      tenantId: 'nike', team: 'Nike Belgium / People Services',
      channel: { id: 'nike:channel:hr-payroll', displayName: 'HR and payroll handover' },
      exportedAt: '2026-09-30T12:00:00Z',
      messages: chronological([...noiseMessages(roster, 'hr', hrNoise, 17, 4), ...relevant]),
    }],
    ['teams/retail-operations-september.json', {
      tenantId: 'nike', team: 'Nike Belgium / Retail Operations',
      channel: { id: 'nike:channel:retail-operations', displayName: 'Retail operations' },
      exportedAt: '2026-09-30T12:00:00Z',
      messages: chronological(noiseMessages(roster, 'retail', retailNoise, 16, 8)),
    }],
    ['teams/benefits-september.json', {
      tenantId: 'nike', team: 'Nike Belgium / People Services',
      channel: { id: 'nike:channel:benefits', displayName: 'Benefits and learning' },
      exportedAt: '2026-09-30T12:00:00Z',
      messages: chronological(noiseMessages(roster, 'benefits', benefitNoise, 18, 15)),
    }],
  ]);
}

function evidence(path, extra = {}) {
  return { system: path.split('/')[0], path, ...extra };
}
function acceptanceOracle(roster, sourceCounts) {
  const dossier = evidence(roster[0].dossierPath);
  const move = evidence(MOVE_PATH, { messageId: 'nike-gmail-abel-move-20260921@nike.example' });
  const ack = evidence(HR_PATH, { messageId: 'nike-teams-abel-ack-20260922' });
  const commitment = evidence(HR_PATH, { messageId: 'nike-teams-abel-commitment-20260922' });
  const followup = evidence(HR_PATH, { messageId: 'nike-teams-abel-followup-20260928' });
  const open = evidence(HR_PATH, { messageId: 'nike-teams-abel-still-open-20260928' });
  const policy = evidence(POLICY_PATH);
  const item = (key, type, summary, value, sources, extra = {}) => ({
    key, entityId: ABEL.id, type, status: 'active', summary, value, sources, ...extra,
  });
  return {
    schemaVersion: 1, acceptanceOnly: true, mustNeverBeIngested: true, tenantId: 'nike',
    interpretation: 'Semantic assertions, not records for ingestion. Keys and summaries do not dictate implementation IDs or exact wording. Amounts are synthetic monthly EUR values. A missing payroll confirmation is not proof of an underpayment.',
    dataset: {
      employeeCount: 50, sourceCounts, employeeSnapshotDate: '2026-09-01', asOf: FIXTURE_DATE,
      scope: 'Fictional SD Worx servicing fictional Nike Belgium employees',
    },
    entity: {
      id: ABEL.id, type: 'employee', name: 'Abel',
      aliases: [
        { kind: 'name', value: 'Abel' }, { kind: 'email', value: ABEL.email },
        { kind: 'employee_id', value: ABEL.employeeId }, { kind: 'teams_user_id', value: ABEL.teamsUserId },
      ],
      aliasNotes: 'Alias namespaces may follow the extractor conventions; all four identities must resolve to the same employee. Teams from is the actor; message.employeeId and mentions identify the affected employee.',
    },
    employees: roster.map(({ id, employeeId, name, email, teamsUserId, dossierPath }) => ({ id, employeeId, name, email, teamsUserId, dossierPath })),
    expectedMemories: [
      item('employer', 'fact', 'Abel works for Nike Belgium.', 'Nike Belgium', [dossier]),
      item('base-salary', 'fact', 'Abel has monthly base salary EUR 1800 in the dossier snapshot.', { amount: 1800, currency: 'EUR', period: 'month' }, [dossier], { validFrom: '2026-09-01' }),
      item('recorded-bicycle-compensation', 'fact', 'The snapshot records EUR 50 bicycle compensation; the later payroll check still appears to show EUR 50.', { amount: 50, currency: 'EUR', period: 'month' }, [dossier, followup], { validFrom: '2026-09-01', uncertainty: 'The later report does not confirm the final amount actually paid.' }),
      item('previous-address', 'fact', 'Abel previously lived at the old address; retain this as historical evidence.', ABEL.oldAddress, [dossier, move], { status: 'superseded', validFrom: '2026-09-01', validUntil: ABEL.moveEffectiveDate }),
      item('previous-commute', 'fact', 'The older dossier records a 5 km one-way bicycle commute.', { distanceKm: 5, basis: 'one-way' }, [dossier, move], { status: 'superseded', validFrom: '2026-09-01', validUntil: ABEL.moveEffectiveDate }),
      item('move', 'event', 'Abel moved on 2026-09-20 and notified HR by email the next day.', { oldAddress: ABEL.oldAddress, newAddress: ABEL.newAddress, effectiveDate: ABEL.moveEffectiveDate }, [move, ack], { occurredAt: '2026-09-20T00:00:00Z', notifiedAt: '2026-09-21T07:35:00Z' }),
      item('current-address', 'fact', 'The new home address is current from 2026-09-20.', ABEL.newAddress, [move, ack], { validFrom: ABEL.moveEffectiveDate }),
      item('commute-change', 'event', 'The one-way bicycle commute increased from about 5 km to about 15 km, approximately 10 km longer.', { previousKm: 5, currentKm: 15, increaseKm: 10, approximate: true, basis: 'one-way' }, [dossier, move], { occurredAt: '2026-09-20T00:00:00Z', validFrom: ABEL.moveEffectiveDate, acceptableTypes: ['event', 'context', 'fact'] }),
      item('hr-acknowledgment', 'event', 'HR acknowledged the address change.', { actor: 'Sarah Van Doren', effectiveDate: ABEL.moveEffectiveDate }, [ack, move], { occurredAt: '2026-09-22T08:40:00Z', acceptableTypes: ['event', 'context'] }),
      item('hr-commitment', 'commitment', 'HR committed to update the dossier and pass the address and bicycle-commute change to SD Worx.', { actor: 'Sarah Van Doren', recipient: 'SD Worx', fulfilled: null }, [commitment], { occurredAt: '2026-09-22T08:43:00Z', uncertainty: 'An acknowledgment and promise do not prove a completed update.' }),
      item('unprocessed-update', 'issue', 'Later evidence suggests the address and commute update was not carried through; confirmation remains missing.', { state: 'open', processingConfirmed: false, reportedRecordedAddress: ABEL.oldAddress, reportedBicycleCompensation: 50 }, [followup, open, commitment], { status: 'uncertain', acceptableStatuses: ['active', 'uncertain'], occurredAt: '2026-09-28T10:20:00Z', uncertainty: 'Apparent failure, pending payroll confirmation. Do not convert it into a proven failure or resolution.' }),
      item('mobility-policy', 'context', 'The synthetic policy band for a regular one-way bicycle commute of at least 10 km is EUR 80 per month.', { currency: 'EUR', period: 'month', bands: [{ minKm: 0, maxKmExclusive: 10, amount: 50 }, { minKm: 10, maxKmExclusive: null, amount: 80 }] }, [policy], { validFrom: '2026-09-01', scope: 'Nike Belgium policy; may be linked to Abel instead of duplicated per employee.' }),
      item('supported-bicycle-compensation', 'context', 'Combining the new commute with the synthetic policy supports potential EUR 80 monthly bicycle compensation.', { amount: 80, currency: 'EUR', period: 'month', oneWayDistanceKm: 15 }, [move, policy], { status: 'uncertain', acceptableStatuses: ['active', 'uncertain'], validFrom: ABEL.moveEffectiveDate, derived: true, uncertainty: 'Policy-based expectation; no source confirms payroll has applied it.' }),
      item('potential-discrepancy', 'issue', 'There may be a EUR 30 monthly discrepancy between the recorded EUR 50 and policy-supported EUR 80 compensation.', { recordedAmount: 50, policySupportedAmount: 80, potentialDifference: 30, currency: 'EUR', period: 'month', confirmedUnderpayment: false }, [dossier, move, followup, policy], { status: 'uncertain', acceptableStatuses: ['active', 'uncertain'], validFrom: ABEL.moveEffectiveDate, derived: true, uncertainty: 'Open potential discrepancy, not a confirmed underpayment.' }),
    ],
    expectedRelations: [
      { from: 'current-address', type: 'supersedes', to: 'previous-address' },
      { from: 'move', type: 'relates_to', to: 'current-address' },
      { from: 'hr-acknowledgment', type: 'supports', to: 'move' },
      { from: 'hr-commitment', type: 'relates_to', to: 'move' },
      { from: 'unprocessed-update', type: 'relates_to', to: 'hr-commitment' },
      { from: 'potential-discrepancy', type: 'relates_to', to: 'unprocessed-update' },
    ],
    acceptance: {
      currentAddress: { value: ABEL.newAddress, effectiveDate: ABEL.moveEffectiveDate, previousAddress: ABEL.oldAddress, sourcePaths: [MOVE_PATH, HR_PATH] },
      recentChanges: ['previous-address', 'move', 'current-address', 'commute-change', 'hr-acknowledgment', 'hr-commitment', 'unprocessed-update'],
      timelineDates: ['2026-09-01', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-28'],
      openIssues: ['unprocessed-update', 'potential-discrepancy'],
      requiredBehavior: [
        'Resolve Abel, abel@nike.example, EMP-001 and nike:teams:abel to nike:employee:abel.',
        'Return semantic memories with immutable source-version evidence, not lists of search hits.',
        'Never return the old and new addresses as equally current.',
        'Preserve the old address and dossier evidence after supersession.',
        'Keep acknowledgment, commitment and unresolved update issue distinct.',
        'Retain uncertainty; no source proves a final payroll correction or underpayment.',
        'Skip unchanged source ingestion without creating duplicate memories.',
        'Never ingest expected-memory.json, manifest.json, README.md or generator/test code.',
      ],
    },
  };
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;
export function buildFixture() {
  const files = new Map();
  const roster = employees();
  for (const employee of roster) files.set(employee.dossierPath, textPdf({
    title: 'Employee dossier', subtitle: 'Nike Belgium | SD Worx service snapshot',
    lines: dossierLines(employee), reference: `${employee.employeeId} / snapshot ${employee.snapshotDate}`,
  }));
  files.set(POLICY_PATH, textPdf({
    title: 'Bicycle mobility policy', subtitle: 'Nike Belgium | Synthetic policy context',
    lines: POLICY_LINES, reference: 'nike-mobility-2026-09 / effective 2026-09-01',
  }));
  files.set(MOVE_PATH, Buffer.from(email({
    from: 'Abel <abel@nike.example>', date: '2026-09-21T07:35:00Z', id: 'nike-gmail-abel-move-20260921',
    subject: 'Home address change effective 2026-09-20', employeeId: ABEL.employeeId,
    body: `Hi Sarah,\n\nI moved on 2026-09-20. My previous address was ${ABEL.oldAddress}.\nMy new address is ${ABEL.newAddress}; please use it effective 2026-09-20.\n\nMy bicycle commute to work used to be about 5 km one-way. It is now approximately 15 km one-way, so about 10 km longer. I still cycle regularly.\nCould you update my contact details and let the relevant team know about the commute change?\n\nThanks,\nAbel\nEmployee ID: EMP-001`,
  })));
  for (const [index, [subject, body]] of emailNoise.entries()) {
    const employee = roster[index + 2];
    const date = `2026-09-${String(8 + index % 20).padStart(2, '0')}`;
    files.set(`gmail/${date}-${employee.employeeId.toLowerCase()}-${slug(subject)}.txt`, Buffer.from(email({
      from: `${employee.name} <${employee.email}>`, to: index % 2 ? 'Store Support <store.support@nike.example>' : 'People Services <people.services@nike.example>',
      date: `${date}T${index % 2 ? '13' : '08'}:10:00Z`, id: `nike-gmail-noise-${String(index + 1).padStart(3, '0')}`,
      subject, employeeId: employee.employeeId, body: `Hi team,\n\n${body}\n\nThanks,\n${employee.name}`,
    })));
  }
  for (const [path, content] of teamsExports(roster)) files.set(path, Buffer.from(json(content)));
  const sourceCounts = { gmail: 26, sharepoint: 51, teams: 3, total: 80 };
  files.set('expected-memory.json', Buffer.from(json(acceptanceOracle(roster, sourceCounts))));
  const sourceFiles = [...files].filter(([path]) => /^(gmail|sharepoint|teams)\//.test(path)).map(([path, bytes]) => ({
    path, system: path.split('/')[0], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  })).sort((a, b) => a.path.localeCompare(b.path));
  files.set('manifest.json', Buffer.from(json({
    schemaVersion: 1, acceptanceOnly: true, mustNeverBeIngested: true,
    generator: 'scripts/mock-data/generate.mjs', fixtureDate: FIXTURE_DATE,
    employeeCount: roster.length, sourceCounts, teamsMessageCount: 64,
    sourceFiles,
  })));
  return files;
}

export async function generate(outputDirectory, { check = false } = {}) {
  const files = buildFixture();
  for (const [path, content] of files) {
    const destination = resolve(outputDirectory, path);
    if (check) {
      const existing = await readFile(destination);
      if (!content.equals(existing)) throw new Error(`Generated fixture differs: ${path}`);
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
  return { generatedFiles: files.size, sourceFiles: 80, employees: 50 };
}

if (!process.execArgv.includes('-e') && !process.execArgv.includes('--eval') && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'boolean', default: false } } });
  const defaultDirectory = fileURLToPath(new URL('../../mock-data/nike/', import.meta.url));
  const result = await generate(resolve(values.out ?? defaultDirectory), { check: values.check });
  console.log(`${values.check ? 'Verified' : 'Generated'} ${result.sourceFiles} source files for ${result.employees} employees (${result.generatedFiles} files including acceptance metadata).`);
}
