/**
 * Seed data. M0: `npm run db:reset && npm run db:seed` must produce a realistic roster
 * and case set — realistic enough that every Today bucket populates and the credential
 * engine has real edge cases to chew on.
 *
 * Everything is dated relative to today, so the seed stays meaningful whenever it runs.
 * Names, addresses and policy numbers are invented.
 */
import { openMigrationDb, type DbHandle } from './client';
import { applyMigrations, loadWorkspaceEnv } from './migrate';
import { truncateAll } from '../testing/db';
import { addDays, civilLA, formatISODate } from '../domain/dates';
import { writtenStatementDueOn } from '../domain/businessDays';

const NOW = new Date();
const TODAY = civilLA(NOW);
const d = (n: number) => formatISODate(addDays(TODAY, n));
const TODAY_ISO = formatISODate(TODAY);

const AREAS = ['Pasadena', 'South Pasadena', 'San Marino', 'Altadena', 'Arcadia',
  'Glendale', 'La Cañada', 'Sierra Madre', 'Monrovia', 'Eagle Rock'];

const ALL_BLOCKS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  .flatMap((day) => ['AM', 'PM', 'NOC'].map((b) => `${day}:${b}`));

const weekdays = (block: string) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((x) => `${x}:${block}`);

type Cred = {
  type: string; expires: number | null; verified: number; source: string; identifier?: string;
};

interface SeedProvider {
  name: string;
  type: 'RN' | 'LVN' | 'CNA' | 'HCA' | 'companion';
  status?: 'active' | 'inactive' | 'do_not_refer';
  rate: number | null;
  transports: boolean;
  areas: string[];
  availability: string[];
  specialties: string[];
  languages: string[];
  license?: string;
  restrictions?: string;
  paperwork?: { agreement?: number | null; notice?: number | null; workAuth?: number | null };
  creds: Cred[];
  note?: string;
}

const LIVE_SCAN = (verified: number): Cred =>
  ({ type: 'live_scan', expires: null, verified, source: 'CA DOJ subsequent arrest notification' });
const TB = (expires: number, verified: number): Cred =>
  ({ type: 'tb_clearance', expires, verified, source: 'Clearance letter from issuing clinic' });
const CPR = (expires: number, verified: number): Cred =>
  ({ type: 'cpr_bls', expires, verified, source: 'AHA eCard lookup' });

const PROVIDERS: SeedProvider[] = [
  {
    name: 'Alma Reyes', type: 'RN', rate: 68, transports: true, license: 'RN-842113',
    areas: ['Pasadena', 'South Pasadena', 'San Marino'],
    availability: [...weekdays('AM'), ...weekdays('PM')],
    specialties: ['post_surgical', 'wound_care', 'medication_management'],
    languages: ['English', 'Spanish'],
    creds: [
      { type: 'rn_license', expires: 430, verified: -40, source: 'BRN license verification', identifier: 'RN-842113' },
      TB(210, -40), CPR(300, -40), LIVE_SCAN(-40),
      { type: 'auto_insurance', expires: 120, verified: -40, source: 'Declarations page' },
      { type: 'drivers_license', expires: 900, verified: -40, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Grace Okonkwo', type: 'RN', rate: 72, transports: false, license: 'RN-771904',
    areas: ['Glendale', 'La Cañada', 'Pasadena'],
    availability: [...weekdays('PM'), 'Sat:AM', 'Sat:PM'],
    specialties: ['skilled_nursing', 'infusion', 'post_surgical'],
    languages: ['English'],
    creds: [
      { type: 'rn_license', expires: 600, verified: -20, source: 'BRN license verification', identifier: 'RN-771904' },
      // Expired yesterday: this is the blocking row on the Today screen.
      TB(-1, -200), CPR(410, -20), LIVE_SCAN(-200),
    ],
    note: 'TB clearance lapsed. Renewal appointment booked.',
  },
  {
    name: 'Rosalind Pham', type: 'RN', rate: 70, transports: true, license: 'RN-903552',
    areas: ['Arcadia', 'Monrovia', 'Sierra Madre', 'Pasadena'],
    availability: [...weekdays('NOC'), 'Sat:NOC', 'Sun:NOC'],
    specialties: ['overnight_newborn', 'skilled_nursing'],
    languages: ['English', 'Vietnamese'],
    creds: [
      { type: 'rn_license', expires: 380, verified: -75, source: 'BRN license verification' },
      TB(6, -75), CPR(190, -75), LIVE_SCAN(-75),
      { type: 'auto_insurance', expires: 240, verified: -75, source: 'Declarations page' },
      { type: 'drivers_license', expires: 1100, verified: -75, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Danielle Whitfield', type: 'LVN', rate: 44, transports: false, license: 'VN-556201',
    areas: ['Pasadena', 'Altadena', 'Eagle Rock'],
    availability: [...weekdays('AM')],
    specialties: ['personal_care', 'medication_management', 'hospice_support'],
    languages: ['English'],
    creds: [
      { type: 'lvn_license', expires: 500, verified: -15, source: 'BVNPT license verification' },
      TB(170, -15), CPR(25, -15), LIVE_SCAN(-15),
    ],
  },
  {
    name: 'Marisol Aguirre', type: 'LVN', rate: 46, transports: true, license: 'VN-610447',
    areas: ['South Pasadena', 'Pasadena', 'San Marino'],
    availability: [...weekdays('PM'), 'Sat:PM'],
    specialties: ['post_surgical', 'personal_care'],
    languages: ['English', 'Spanish'],
    creds: [
      { type: 'lvn_license', expires: 350, verified: -95, source: 'BVNPT license verification' },
      TB(80, -95), CPR(260, -95), LIVE_SCAN(-95),
      { type: 'auto_insurance', expires: 65, verified: -95, source: 'Declarations page' },
      { type: 'drivers_license', expires: 700, verified: -95, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Tomás Beltrán', type: 'LVN', rate: 45, transports: true,
    areas: ['Monrovia', 'Arcadia'],
    availability: [...weekdays('AM'), ...weekdays('PM')],
    specialties: ['personal_care', 'respite'],
    languages: ['English', 'Spanish'],
    // Missing Live Scan entirely. Never eligible until recorded.
    creds: [
      { type: 'lvn_license', expires: 420, verified: -10, source: 'BVNPT license verification' },
      TB(190, -10), CPR(220, -10),
      { type: 'auto_insurance', expires: 300, verified: -10, source: 'Declarations page' },
      { type: 'drivers_license', expires: 800, verified: -10, source: 'Physical inspection' },
    ],
    paperwork: { workAuth: null },
    note: 'Live Scan submitted, awaiting DOJ response.',
  },
  {
    name: 'Yolanda Brooks', type: 'CNA', rate: 34, transports: true,
    areas: ['Pasadena', 'Altadena', 'Sierra Madre'],
    availability: [...weekdays('AM'), 'Sat:AM', 'Sun:AM'],
    specialties: ['personal_care', 'dementia', 'respite'],
    languages: ['English'],
    creds: [
      { type: 'cna_cert', expires: 290, verified: -30, source: 'CDPH Aide and Technician registry' },
      TB(140, -30), CPR(330, -30), LIVE_SCAN(-30),
      { type: 'auto_insurance', expires: 400, verified: -30, source: 'Declarations page' },
      { type: 'drivers_license', expires: 950, verified: -30, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Priya Raghunathan', type: 'CNA', rate: 36, transports: false,
    areas: ['Arcadia', 'Pasadena', 'San Marino'],
    availability: [...weekdays('PM'), ...weekdays('NOC')],
    specialties: ['dementia', 'personal_care', 'hospice_support'],
    languages: ['English', 'Hindi', 'Tamil'],
    creds: [
      { type: 'cna_cert', expires: 520, verified: -60, source: 'CDPH Aide and Technician registry' },
      TB(95, -60), CPR(150, -60), LIVE_SCAN(-60),
    ],
  },
  {
    name: 'Nadia Haddad', type: 'CNA', rate: 35, transports: true,
    areas: ['Glendale', 'Eagle Rock', 'Pasadena'],
    availability: [...weekdays('AM'), ...weekdays('PM'), 'Sat:AM'],
    specialties: ['personal_care', 'post_surgical'],
    languages: ['English', 'Arabic'],
    creds: [
      { type: 'cna_cert', expires: 180, verified: -200, source: 'CDPH Aide and Technician registry' },
      TB(220, -200), CPR(88, -200), LIVE_SCAN(-200),
      { type: 'auto_insurance', expires: 150, verified: -200, source: 'Declarations page' },
      { type: 'drivers_license', expires: 600, verified: -200, source: 'Physical inspection' },
    ],
    note: 'All credentials verified over 180 days ago — due for re-verification.',
  },
  {
    name: 'Esperanza Cruz', type: 'HCA', rate: 28, transports: true,
    areas: ['Pasadena', 'South Pasadena', 'Altadena'],
    availability: [...weekdays('AM'), ...weekdays('PM'), 'Sat:AM', 'Sat:PM'],
    specialties: ['companion', 'personal_care', 'meal_preparation'],
    languages: ['English', 'Spanish'],
    creds: [
      { type: 'hca_registry', expires: 330, verified: -25, source: 'CA Home Care Aide Registry' },
      TB(260, -25), LIVE_SCAN(-25),
      { type: 'auto_insurance', expires: 210, verified: -25, source: 'Declarations page' },
      { type: 'drivers_license', expires: 1000, verified: -25, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Lucille Barnett', type: 'HCA', rate: 27, transports: false,
    areas: ['Sierra Madre', 'Arcadia', 'Monrovia'],
    availability: [...weekdays('AM'), 'Sun:AM', 'Sun:PM'],
    specialties: ['companion', 'dementia'],
    languages: ['English'],
    creds: [
      { type: 'hca_registry', expires: 470, verified: -45, source: 'CA Home Care Aide Registry' },
      TB(29, -45), LIVE_SCAN(-45),
    ],
  },
  {
    name: 'Fatima Noor', type: 'HCA', rate: 29, transports: true,
    areas: ['Glendale', 'La Cañada', 'Pasadena'],
    availability: [...weekdays('NOC'), 'Sat:NOC'],
    specialties: ['companion', 'overnight_newborn', 'respite'],
    languages: ['English', 'Urdu'],
    creds: [
      { type: 'hca_registry', expires: 240, verified: -35, source: 'CA Home Care Aide Registry' },
      TB(310, -35), LIVE_SCAN(-35),
      { type: 'auto_insurance', expires: 90, verified: -35, source: 'Declarations page' },
      { type: 'drivers_license', expires: 880, verified: -35, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Jean Mbeki', type: 'companion', rate: 24, transports: true,
    areas: ['Pasadena', 'Eagle Rock', 'Glendale'],
    availability: [...weekdays('PM'), 'Sat:PM', 'Sun:PM'],
    specialties: ['companion', 'transportation', 'errands'],
    languages: ['English', 'French'],
    creds: [
      LIVE_SCAN(-18), TB(275, -18),
      { type: 'auto_insurance', expires: 185, verified: -18, source: 'Declarations page' },
      { type: 'drivers_license', expires: 760, verified: -18, source: 'Physical inspection' },
    ],
  },
  {
    name: 'Harriet Soon', type: 'companion', rate: 23, transports: true,
    areas: ['San Marino', 'Pasadena', 'Arcadia'],
    availability: [...weekdays('AM'), 'Sat:AM'],
    specialties: ['companion', 'errands'],
    languages: ['English', 'Mandarin'],
    // Transports but no auto insurance on file. Not eligible (§ 3.3 requiredFor).
    creds: [
      LIVE_SCAN(-12), TB(300, -12),
      { type: 'drivers_license', expires: 640, verified: -12, source: 'Physical inspection' },
    ],
    note: 'Drives clients. Awaiting declarations page from carrier.',
  },
  {
    name: 'Bea Villanueva', type: 'companion', rate: 22, transports: false,
    areas: ['Altadena', 'Pasadena'],
    availability: [...weekdays('AM'), ...weekdays('PM')],
    specialties: ['companion', 'meal_preparation'],
    languages: ['English', 'Tagalog'],
    creds: [LIVE_SCAN(-8), TB(330, -8)],
  },
  {
    name: 'Corinne Adeyemi', type: 'CNA', rate: 37, transports: false,
    status: 'inactive',
    areas: ['Pasadena', 'South Pasadena'],
    availability: [...weekdays('AM')],
    specialties: ['personal_care', 'post_surgical'],
    languages: ['English'],
    restrictions: 'No lifting over 25 lbs.',
    creds: [
      { type: 'cna_cert', expires: 610, verified: -50, source: 'CDPH Aide and Technician registry' },
      TB(250, -50), CPR(290, -50), LIVE_SCAN(-50),
    ],
    note: 'On leave until spring. Fully credentialed.',
  },
  {
    name: 'Walter Nkemdirim', type: 'HCA', rate: 26, transports: false,
    status: 'do_not_refer',
    areas: ['Monrovia'],
    availability: [...weekdays('PM')],
    specialties: ['companion'],
    languages: ['English'],
    creds: [
      { type: 'hca_registry', expires: 400, verified: -150, source: 'CA Home Care Aide Registry' },
      TB(160, -150), LIVE_SCAN(-150),
    ],
    note: 'Registry has stopped referring, forward-only (I4). No engagement was ended by the registry.',
  },
  {
    name: 'Imelda Santoyo', type: 'RN', rate: 75, transports: false, license: 'RN-660128',
    areas: ['Pasadena', 'San Marino', 'South Pasadena', 'Altadena', 'Arcadia'],
    availability: ALL_BLOCKS,
    specialties: ['skilled_nursing', 'hospice_support', 'post_surgical', 'wound_care'],
    languages: ['English', 'Spanish'],
    creds: [
      { type: 'rn_license', expires: 700, verified: -5, source: 'BRN license verification' },
      TB(340, -5), CPR(520, -5), LIVE_SCAN(-5),
    ],
    paperwork: { agreement: -5, notice: -5, workAuth: -5 },
  },
];

interface SeedCase {
  household: {
    displayName: string; dmName: string; dmRelationship?: string; dmLocation?: string;
    dmTimezone?: string; crName?: string; crAge?: number; crArea: string;
    physician?: { name: string; practice: string; phone: string; fax?: string };
    payment?: 'private' | 'ltc_policy' | 'va' | 'other';
    ltc?: { carrier: string; policy: string };
    source?: string; accessNotes?: string; nda?: boolean;
  };
  care: string;
  urgency: string;
  status: string;
  needs: string;
  householdProfile?: string;
  adl?: string[];
  schedule: string[];
  hours?: number;
  startsIn?: number;
  endsIn?: number;
  feePct?: number;
  rateAgreed?: number;
  band?: [number, number];
  languagePref?: string;
  primary?: string;
  alternates?: string[];
  logCall?: boolean;
  referral?: { provider: string; disclosedTo: string; daysAgo: number; writtenSent?: boolean };
  ended?: { on: number; by: 'household' | 'provider' | 'mutual'; reason: string; note?: string };
}

const CASES: SeedCase[] = [
  {
    household: {
      displayName: 'Abernathy — San Marino', dmName: 'Claire Abernathy',
      dmRelationship: 'Daughter', dmLocation: 'Boston, MA', dmTimezone: 'America/New_York',
      crName: 'Howard Abernathy', crAge: 87, crArea: 'San Marino',
      physician: { name: 'Dr. Lillian Okafor', practice: 'Huntington Internal Medicine', phone: '(626) 555-0142', fax: '(626) 555-0143' },
      payment: 'ltc_policy', ltc: { carrier: 'Genworth', policy: 'GW-4471902' },
      source: 'Discharge planner referral', nda: true,
      accessNotes: 'Gate code at the Oak Knoll entrance. Dog is friendly but loud.',
    },
    care: 'skilled_nursing', urgency: 'routine', status: 'active',
    needs: 'Dad came home after a long hospital stay and needs his wound dressed and his medications set up every morning. He is sharp but unsteady. He will not accept help with bathing from anyone he has not met twice.',
    householdProfile: 'Mornings only — he naps after lunch and does not want anyone in the house then. Enters through the side door, not the front. Coffee is already made; do not remake it. His wife passed in March and he does not want to talk about it.',
    adl: ['wound_care', 'medication_management'],
    schedule: weekdays('AM'), hours: 20, startsIn: -60, feePct: 18, rateAgreed: 68,
    band: [60, 72], primary: 'Alma Reyes', alternates: ['Imelda Santoyo'],
    referral: { provider: 'Alma Reyes', disclosedTo: 'Claire Abernathy', daysAgo: 62, writtenSent: true },
  },
  {
    household: {
      displayName: 'Oyelaran — Glendale', dmName: 'Tunde Oyelaran',
      dmRelationship: 'Son', dmLocation: 'Glendale, CA', dmTimezone: 'America/Los_Angeles',
      crName: 'Adunni Oyelaran', crAge: 79, crArea: 'Glendale',
      physician: { name: 'Dr. Marcus Reinholt', practice: 'Verdugo Hills Medical Group', phone: '(818) 555-0177' },
      payment: 'private', source: 'Word of mouth',
    },
    care: 'skilled_nursing', urgency: 'routine', status: 'active',
    needs: 'Mum has late-stage COPD. She needs someone in the evenings who can manage her oxygen and knows when to call the doctor rather than wait.',
    householdProfile: 'Evenings, 3pm to 11pm. She prefers to be read to in Yoruba but English is fine. Oxygen concentrator is in the hall closet; spare tanks in the garage.',
    adl: ['skilled_nursing', 'medication_management'],
    schedule: weekdays('PM'), hours: 40, startsIn: -120, feePct: 18, rateAgreed: 72,
    band: [66, 78],
    // Grace Okonkwo's TB clearance expired yesterday -> the Today "blocking" row.
    primary: 'Grace Okonkwo', alternates: [],
    referral: { provider: 'Grace Okonkwo', disclosedTo: 'Tunde Oyelaran', daysAgo: 118, writtenSent: true },
  },
  {
    household: {
      displayName: 'Castellanos — Pasadena', dmName: 'Rafael Castellanos',
      dmRelationship: 'Husband', crName: 'Paloma Castellanos', crAge: 74, crArea: 'Pasadena',
      payment: 'private', source: 'Returning household',
      physician: { name: 'Dr. Anne Beaumont', practice: 'Huntington Neurology', phone: '(626) 555-0190' },
    },
    care: 'personal_care', urgency: 'routine', status: 'active',
    needs: 'My wife has Parkinson\'s. I do the nights. I need help in the mornings with bathing and breakfast so I can sleep.',
    householdProfile: 'Weekday mornings. He sleeps until 10 — be quiet in the hallway. She likes the radio on, KUSC. Shower chair is already installed.',
    adl: ['personal_care', 'dementia'],
    schedule: weekdays('AM'), hours: 25, startsIn: -200, feePct: 18, rateAgreed: 34,
    band: [30, 38], primary: 'Yolanda Brooks', alternates: ['Esperanza Cruz', 'Bea Villanueva'],
    referral: { provider: 'Yolanda Brooks', disclosedTo: 'Rafael Castellanos', daysAgo: 205, writtenSent: true },
  },
  {
    household: {
      displayName: 'Lindqvist — Altadena', dmName: 'Sofia Lindqvist',
      dmRelationship: 'Daughter', dmLocation: 'Stockholm, Sweden', dmTimezone: 'Europe/Stockholm',
      crName: 'Birgit Lindqvist', crAge: 91, crArea: 'Altadena',
      payment: 'private', source: 'Partner: Huntington discharge planning',
    },
    care: 'companion', urgency: 'routine', status: 'active',
    needs: 'Grandmother lives alone and is lonely more than she is unwell. Someone to sit with her, make lunch, and tell me if something changes.',
    householdProfile: 'Afternoons. She is nine hours behind her daughter — call Sofia before 9am California time or after 11pm. Lunch at 12:30 sharp. She does not like the television on.',
    adl: ['companion', 'meal_preparation'],
    schedule: weekdays('PM'), hours: 20, startsIn: -40, endsIn: 9, feePct: 18, rateAgreed: 22,
    band: [20, 26], primary: 'Bea Villanueva', alternates: ['Esperanza Cruz'],
    referral: { provider: 'Bea Villanueva', disclosedTo: 'Sofia Lindqvist', daysAgo: 44, writtenSent: true },
  },
  {
    household: {
      displayName: 'Mwangi — Arcadia', dmName: 'Grace Mwangi',
      dmRelationship: 'Daughter-in-law', crName: 'Joseph Mwangi', crAge: 83, crArea: 'Arcadia',
      payment: 'private', source: 'Discharge planner referral',
      physician: { name: 'Dr. Priscilla Vance', practice: 'Methodist Hospital of Southern California', phone: '(626) 555-0211', fax: '(626) 555-0212' },
    },
    care: 'post_surgical', urgency: 'discharge', status: 'referred',
    needs: 'He comes home Thursday after a hip replacement. We need someone the first two weeks who can help him move safely and watch the incision.',
    householdProfile: 'Discharge Thursday. Hospital bed delivered to the front room. Family is large and will be in and out; the care recipient tires of it quickly.',
    adl: ['post_surgical', 'personal_care'],
    schedule: [...weekdays('AM'), 'Sat:AM', 'Sun:AM'], hours: 35, startsIn: 3, endsIn: 17,
    feePct: 20, band: [62, 74], primary: 'Imelda Santoyo', alternates: [],
    referral: { provider: 'Imelda Santoyo', disclosedTo: 'Grace Mwangi', daysAgo: 0, writtenSent: false },
  },
  {
    household: {
      displayName: 'Tanaka — South Pasadena', dmName: 'Ken Tanaka',
      dmRelationship: 'Son', dmLocation: 'Seattle, WA', dmTimezone: 'America/Los_Angeles',
      crName: 'Michiko Tanaka', crAge: 88, crArea: 'South Pasadena',
      payment: 'ltc_policy', ltc: { carrier: 'John Hancock', policy: 'JH-88214400' },
      source: 'Elder law attorney referral',
    },
    care: 'hospice_support', urgency: 'same_day', status: 'matching',
    needs: 'Hospice started yesterday. We want someone overnight so my sister can sleep. We are not looking for medical care, just presence and help turning her.',
    householdProfile: 'Overnights. Sister sleeps in the next room. House is quiet after 9pm. Hospice nurse visits Tuesdays and Fridays.',
    adl: ['hospice_support', 'personal_care'],
    schedule: [...weekdays('NOC'), 'Sat:NOC', 'Sun:NOC'], hours: 56, startsIn: 2,
    feePct: 20, band: [34, 42], logCall: true,
    // No physician on the household record: the Today "skilled case, no physician" row.
  },
  {
    household: {
      displayName: 'Ferreira — Monrovia', dmName: 'Beatriz Ferreira',
      dmRelationship: 'Wife', crName: 'Jorge Ferreira', crAge: 70, crArea: 'Monrovia',
      payment: 'va', source: 'VA social worker',
    },
    care: 'personal_care', urgency: 'next_day', status: 'inquiry',
    needs: 'My husband is a veteran with diabetes and poor eyesight. He needs help with his insulin and getting to appointments. I work days.',
    adl: ['medication_management', 'transportation'],
    schedule: weekdays('AM'), hours: 25, startsIn: 7, feePct: 18, band: [32, 40],
    languagePref: 'Spanish',
  },
  {
    household: {
      displayName: 'Okafor — Pasadena', dmName: 'Chidi Okafor',
      dmRelationship: 'Son', crName: 'Ngozi Okafor', crAge: 76, crArea: 'Pasadena',
      payment: 'private', source: 'Website enquiry',
    },
    care: 'respite', urgency: 'routine', status: 'inquiry',
    needs: 'I care for my mother full time and I have not had a weekend off in a year. I want someone reliable two Saturdays a month.',
    adl: ['respite', 'companion'],
    schedule: ['Sat:AM', 'Sat:PM'], hours: 16, startsIn: 21, feePct: 18, band: [26, 34],
  },
  {
    household: {
      displayName: 'Rosenthal — La Cañada', dmName: 'Dov Rosenthal',
      dmRelationship: 'Son', dmLocation: 'New York, NY', dmTimezone: 'America/New_York',
      crName: 'Miriam Rosenthal', crAge: 84, crArea: 'La Cañada',
      payment: 'private', source: 'Partner: geriatric care manager',
    },
    care: 'companion', urgency: 'discharge', status: 'inquiry',
    needs: 'Mum is being discharged tomorrow after a fall. Nobody is local. I need someone there when she gets home and I do not know what I am doing.',
    adl: ['companion', 'personal_care'],
    schedule: [...weekdays('AM'), ...weekdays('PM')], hours: 50, startsIn: 1,
    feePct: 20, band: [28, 36],
  },
  {
    household: {
      displayName: 'Delacroix — Eagle Rock', dmName: 'Simone Delacroix',
      dmRelationship: 'Daughter', crName: 'Henriette Delacroix', crAge: 81, crArea: 'Eagle Rock',
      payment: 'private', source: 'Word of mouth',
    },
    care: 'companion', urgency: 'routine', status: 'ended',
    needs: 'Someone to drive her to church and the market twice a week and keep her company.',
    adl: ['companion', 'transportation', 'errands'],
    schedule: ['Tue:PM', 'Sun:AM'], hours: 10, startsIn: -300, feePct: 18, rateAgreed: 24,
    band: [22, 28], primary: 'Jean Mbeki',
    referral: { provider: 'Jean Mbeki', disclosedTo: 'Simone Delacroix', daysAgo: 304, writtenSent: true },
    // The leakage case. § 8: this is the option that must exist on a fixed list.
    ended: {
      on: -14, by: 'household', reason: 'moved_to_direct_arrangement',
      note: 'Household arranged directly with the referred provider. Asked to keep us for fill-in cover.',
    },
  },
  {
    household: {
      displayName: 'Shaw — Sierra Madre', dmName: 'Edith Shaw',
      dmRelationship: 'Self', crName: 'Edith Shaw', crAge: 78, crArea: 'Sierra Madre',
      payment: 'private', source: 'Returning household',
    },
    care: 'overnight_newborn', urgency: 'routine', status: 'matching',
    needs: 'My granddaughter is due in six weeks and will be staying with me. We want overnight help with the baby for the first month.',
    adl: ['overnight_newborn'],
    schedule: [...weekdays('NOC'), 'Sat:NOC', 'Sun:NOC'], hours: 56, startsIn: 42,
    feePct: 18, band: [36, 46], logCall: true,
  },
  {
    household: {
      displayName: 'Bhattacharya — San Marino', dmName: 'Anil Bhattacharya',
      dmRelationship: 'Son', dmLocation: 'London, UK', dmTimezone: 'Europe/London',
      crName: 'Sunita Bhattacharya', crAge: 86, crArea: 'San Marino',
      payment: 'private', source: 'Partner: estate attorney', nda: true,
      physician: { name: 'Dr. Howard Lim', practice: 'Huntington Cardiology', phone: '(626) 555-0255' },
    },
    care: 'personal_care', urgency: 'routine', status: 'active',
    needs: 'Mother is frail and forgets her tablets. She is proud and will say she does not need anyone. Please send the same person each time.',
    householdProfile: 'Weekday afternoons. Same person each visit — continuity matters more than anything else here. She will offer tea; accept it. Son calls Sundays from London.',
    adl: ['personal_care', 'medication_management', 'dementia'],
    schedule: weekdays('PM'), hours: 25, startsIn: -90, feePct: 18, rateAgreed: 36,
    band: [32, 40], primary: 'Priya Raghunathan', alternates: ['Harriet Soon'],
    referral: { provider: 'Priya Raghunathan', disclosedTo: 'Anil Bhattacharya', daysAgo: 95, writtenSent: true },
  },
];

async function seed(handle: DbHandle): Promise<void> {
  const q = handle.query.bind(handle);
  await handle.exec(`SET app.operator_id = 'seed'`);

  const [partnerA] = await q<{ id: string }>(
    `INSERT INTO referral_partners (name, org, role, phone, email)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    ['Dolores Hwang', 'Huntington Hospital', 'Discharge planner', '(626) 555-0100', 'd.hwang@example.org'],
  );
  await q(
    `INSERT INTO referral_partners (name, org, role, phone, email) VALUES ($1,$2,$3,$4,$5)`,
    ['Martin Qureshi', 'Qureshi Elder Law', 'Attorney', '(626) 555-0109', 'martin@example.com'],
  );
  await q(
    `INSERT INTO referral_partners (name, org, role, phone, email) VALUES ($1,$2,$3,$4,$5)`,
    ['Renée Alvarado', 'Alvarado Care Management', 'Geriatric care manager', '(323) 555-0188', 'renee@example.com'],
  );

  await q(
    `INSERT INTO users (email, display_name, role) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO NOTHING`,
    [(process.env.OPERATOR_EMAILS ?? 'operator@example.com').split(',')[0]?.trim(), 'Operator', 'operator'],
  );

  const providerIds = new Map<string, string>();
  for (const p of PROVIDERS) {
    const paperwork = p.paperwork ?? {};
    const [row] = await q<{ id: string }>(
      `INSERT INTO providers
         (status, full_name, type, phone, email, license_number, rate_hourly, rate_notes,
          transports, areas, max_travel_min, availability, restrictions, specialties,
          languages, notes, agreement_signed_on, written_notice_ack_on, work_auth_verified_on,
          orientation_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        p.status ?? 'active', p.name, p.type,
        `(626) 555-${String(1000 + PROVIDERS.indexOf(p) * 7).slice(-4)}`,
        `${p.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
        p.license ?? null,
        p.rate, p.rate === null ? null : 'Provider-stated. Negotiable with the household.',
        p.transports, p.areas, 30, p.availability, p.restrictions ?? null,
        p.specialties, p.languages, p.note ?? null,
        paperwork.agreement === undefined ? d(-220) : paperwork.agreement === null ? null : d(paperwork.agreement),
        paperwork.notice === undefined ? d(-220) : paperwork.notice === null ? null : d(paperwork.notice),
        paperwork.workAuth === undefined ? d(-220) : paperwork.workAuth === null ? null : d(paperwork.workAuth),
        d(-218),
      ],
    );
    if (!row) throw new Error(`could not insert provider ${p.name}`);
    providerIds.set(p.name, row.id);

    for (const c of p.creds) {
      const [cred] = await q<{ id: string }>(
        `INSERT INTO credentials
           (provider_id, type, identifier, issued_on, expires_on, verified_on, verified_by,
            verification_source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [row.id, c.type, c.identifier ?? null,
          c.expires === null ? d(c.verified - 30) : d(c.expires - 730),
          c.expires === null ? null : d(c.expires),
          d(c.verified), 'operator', c.source, null],
      );
      if (cred) {
        await q(
          `INSERT INTO credential_events (credential_id, actor, new_expires_on, new_verified_on, note)
           VALUES ($1,$2,$3,$4,$5)`,
          [cred.id, 'seed', c.expires === null ? null : d(c.expires), d(c.verified), 'Initial record'],
        );
      }
    }
  }

  for (const sc of CASES) {
    const h = sc.household;
    const [household] = await q<{ id: string }>(
      `INSERT INTO households
         (display_name, status, dm_name, dm_relationship, dm_phone, dm_email, dm_location,
          dm_timezone, cr_name, cr_age, cr_area, cr_address, cr_access_notes, payment_method,
          ltc_carrier, ltc_policy_number, physician_name, physician_practice, physician_phone,
          physician_fax, nda_on_file, source, partner_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING id`,
      [
        h.displayName, sc.status === 'ended' ? 'ended' : 'open', h.dmName, h.dmRelationship ?? null,
        `(626) 555-${String(2000 + CASES.indexOf(sc) * 11).slice(-4)}`,
        `${h.dmName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
        h.dmLocation ?? null, h.dmTimezone ?? 'America/Los_Angeles',
        h.crName ?? null, h.crAge ?? null, h.crArea,
        `${100 + CASES.indexOf(sc) * 13} ${['Oak Knoll', 'Lincoln', 'Mariposa', 'Wilson', 'Michillinda'][CASES.indexOf(sc) % 5]} Ave, ${h.crArea}, CA`,
        h.accessNotes ?? null, h.payment ?? 'private',
        h.ltc?.carrier ?? null, h.ltc?.policy ?? null,
        h.physician?.name ?? null, h.physician?.practice ?? null,
        h.physician?.phone ?? null, h.physician?.fax ?? null,
        h.nda ?? false, h.source ?? null,
        h.source?.startsWith('Partner') ? partnerA?.id ?? null : null,
        null,
      ],
    );
    if (!household) throw new Error(`could not insert household ${h.displayName}`);

    const primaryId = sc.primary ? providerIds.get(sc.primary) ?? null : null;
    const alternateIds = (sc.alternates ?? [])
      .map((n) => providerIds.get(n))
      .filter((x): x is string => Boolean(x));

    // A case is inserted at its pre-referral status, then moved forward, so the
    // physician trigger fires on the transition exactly as it will in production.
    const [kase] = await q<{ id: string }>(
      `INSERT INTO cases
         (household_id, status, care, urgency, needs_profile, adl_needs, schedule,
          hours_per_week, starts_on, ends_on, expected_weeks, rate_agreed, fee_pct,
          rate_band_low, rate_band_high, language_pref, primary_provider_id,
          alternate_provider_ids, household_profile, created_at)
       VALUES ($1,'inquiry',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        household.id, sc.care, sc.urgency, sc.needs, sc.adl ?? [], sc.schedule,
        sc.hours ?? null,
        sc.startsIn === undefined ? null : d(sc.startsIn),
        sc.endsIn === undefined ? null : d(sc.endsIn),
        sc.endsIn !== undefined && sc.startsIn !== undefined
          ? Math.max(1, Math.round((sc.endsIn - sc.startsIn) / 7)) : null,
        sc.rateAgreed ?? null, sc.feePct ?? null,
        sc.band?.[0] ?? null, sc.band?.[1] ?? null, sc.languagePref ?? null,
        primaryId, alternateIds, sc.householdProfile ?? null,
        new Date(NOW.getTime() - (sc.referral?.daysAgo ?? daysOld(sc)) * 86_400_000).toISOString(),
      ],
    );
    if (!kase) throw new Error(`could not insert case for ${h.displayName}`);

    await q(
      `INSERT INTO timeline_entries (case_id, household_id, type, author, body, at)
       VALUES ($1,$2,'inquiry','intake',$3,$4)`,
      [kase.id, household.id,
        `Enquiry received via ${h.source ?? 'unknown source'}. ${h.dmName} engaging care for ${h.crName ?? 'the care recipient'} in ${h.crArea}.`,
        new Date(NOW.getTime() - (sc.referral?.daysAgo ?? daysOld(sc)) * 86_400_000).toISOString()],
    );
    await q(
      `INSERT INTO metric_events (event, case_id, payload, at)
       VALUES ('inquiry_received', $1, $2::jsonb, $3)`,
      [kase.id, JSON.stringify({ source: h.source, care: sc.care, urgency: sc.urgency }),
        new Date(NOW.getTime() - (sc.referral?.daysAgo ?? daysOld(sc)) * 86_400_000).toISOString()],
    );

    if (sc.logCall) {
      await q(
        `INSERT INTO timeline_entries (case_id, type, author, body) VALUES ($1,'call','operator',$2)`,
        [kase.id, `Spoke with ${h.dmName}. Took the needs profile in their own words and explained how referral works.`],
      );
      await q(`INSERT INTO metric_events (event, case_id) VALUES ('first_contact', $1)`, [kase.id]);
    }

    if (sc.referral) {
      const providerId = providerIds.get(sc.referral.provider);
      if (!providerId) throw new Error(`unknown provider ${sc.referral.provider}`);
      const disclosedOn = d(-sc.referral.daysAgo);
      const dueOn = writtenStatementDueOn(disclosedOn);
      const at = new Date(NOW.getTime() - sc.referral.daysAgo * 86_400_000).toISOString();

      await q(`UPDATE cases SET status = 'referred', referred_on = $2, written_due_on = $3 WHERE id = $1`,
        [kase.id, disclosedOn, dueOn]);

      const [tl] = await q<{ id: string }>(
        `INSERT INTO timeline_entries (case_id, type, author, body, provider_id, at)
         VALUES ($1,'disclosure','operator',$2,$3,$4) RETURNING id`,
        [kase.id,
          `Spoken disclosure given to ${sc.referral.disclosedTo} by phone. Written statement due ${dueOn}.`,
          providerId, at],
      );
      const [disc] = await q<{ id: string }>(
        `INSERT INTO disclosures
           (case_id, timeline_id, disclosed_to, disclosed_by, method, disclosed_at,
            written_due_on, written_sent_on, written_method)
         VALUES ($1,$2,$3,'operator','phone',$4,$5,$6,$7) RETURNING id`,
        [kase.id, tl!.id, sc.referral.disclosedTo, at, dueOn,
          sc.referral.writtenSent ? dueOn : null,
          sc.referral.writtenSent ? 'email and post' : null],
      );
      await q(
        `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by, referred_at, outcome, outcome_at)
         VALUES ($1,$2,$3,'operator',$4,$5,$6)`,
        [kase.id, providerId, disc!.id, at,
          sc.status === 'active' || sc.status === 'ended' ? 'engaged' : null,
          sc.status === 'active' || sc.status === 'ended' ? at : null],
      );
      await q(
        `INSERT INTO timeline_entries (case_id, type, author, body, provider_id, at)
         VALUES ($1,'referral','operator',$2,$3,$4)`,
        [kase.id, `${sc.referral.provider} referred to the household.`, providerId, at],
      );
      await q(
        `INSERT INTO metric_events (event, case_id, provider_id, at) VALUES ('referral_made',$1,$2,$3)`,
        [kase.id, providerId, at],
      );

      if (sc.status === 'active' || sc.status === 'ended') {
        await q(
          `INSERT INTO metric_events (event, case_id, provider_id, at) VALUES ('engagement_started',$1,$2,$3)`,
          [kase.id, providerId, at],
        );
      }
    }

    if (sc.status !== 'inquiry' && sc.status !== 'referred' && sc.status !== 'ended') {
      await q(`UPDATE cases SET status = $2 WHERE id = $1`, [kase.id, sc.status]);
    }

    if (sc.ended) {
      await q(
        `UPDATE cases SET status = 'ended', ended_on = $2, ended_by = $3, end_reason = $4,
                          end_reason_note = $5
          WHERE id = $1`,
        [kase.id, d(sc.ended.on), sc.ended.by, sc.ended.reason, sc.ended.note ?? null],
      );
      await q(
        `INSERT INTO timeline_entries (case_id, type, author, body)
         VALUES ($1,'status_change','operator',$2)`,
        [kase.id, `Engagement ended ${d(sc.ended.on)}, ended by ${sc.ended.by}. Reason: ${sc.ended.reason.replace(/_/g, ' ')}. ${sc.ended.note ?? ''}`.trim()],
      );
      await q(
        `INSERT INTO metric_events (event, case_id, payload) VALUES ('engagement_ended',$1,$2::jsonb)`,
        [kase.id, JSON.stringify({ endReason: sc.ended.reason, endedBy: sc.ended.by, weeks: 41 })],
      );
    }

    // § 8 leakage series: six months of billed hours for the live engagements, with the
    // direct-arrangement case visibly tapering before it ended.
    if (sc.status === 'active' || sc.status === 'ended') {
      const base = sc.hours ?? 20;
      for (let m = 5; m >= 0; m--) {
        const month = `${d(-m * 30).slice(0, 7)}-01`;
        const taper = sc.ended ? Math.max(0.2, 1 - (5 - m) * 0.17) : 1;
        await q(
          `INSERT INTO case_month_hours (case_id, month, billed_hours) VALUES ($1,$2,$3)
           ON CONFLICT (case_id, month) DO NOTHING`,
          [kase.id, month, Math.round(base * 4.33 * taper * 10) / 10],
        );
      }
    }
  }

  // One recorded service failure, so the capacity measure has a non-zero denominator and
  // the operator can see what it counts.
  const [oldest] = await q<{ id: string }>(
    `SELECT id FROM cases WHERE status = 'active' ORDER BY created_at LIMIT 1`,
  );
  if (oldest) {
    await q(
      `INSERT INTO service_failures (case_id, kind, on_date, note) VALUES ($1,$2,$3,$4)`,
      [oldest.id, 'no_eligible_provider_available', d(-23),
        'No eligible alternate was available when the primary called out. Household covered the shift themselves.'],
    );
    await q(
      `INSERT INTO metric_events (event, case_id, payload) VALUES ('service_failure',$1,$2::jsonb)`,
      [oldest.id, JSON.stringify({ kind: 'no_eligible_provider_available' })],
    );
  }

  const counts = await q<{ t: string; n: string }>(
    `SELECT 'providers' AS t, count(*)::text AS n FROM providers
     UNION ALL SELECT 'credentials', count(*)::text FROM credentials
     UNION ALL SELECT 'households', count(*)::text FROM households
     UNION ALL SELECT 'cases', count(*)::text FROM cases
     UNION ALL SELECT 'referrals', count(*)::text FROM referrals
     UNION ALL SELECT 'disclosures', count(*)::text FROM disclosures
     UNION ALL SELECT 'timeline_entries', count(*)::text FROM timeline_entries
     UNION ALL SELECT 'metric_events', count(*)::text FROM metric_events
     ORDER BY t`,
  );
  for (const row of counts) console.log(`  ${row.t.padEnd(18)} ${row.n}`);
}

function daysOld(sc: SeedCase): number {
  return sc.urgency === 'discharge' ? 1 : sc.urgency === 'same_day' ? 1 : sc.urgency === 'next_day' ? 3 : 6;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const handle = await openMigrationDb();
  console.log(`driver: ${handle.driver}`);

  // Seeding truncates every table. On a remote database that is a data-loss event, so it
  // takes an explicit flag rather than an accidental env var.
  if (handle.driver === 'postgres' && !process.argv.includes('--i-mean-it')) {
    console.error(
      'Refusing to seed a remote Postgres.\n'
      + 'This TRUNCATEs every table, including any real household and provider records. '
      + 'If the database is genuinely empty and you want demonstration data, re-run with '
      + '--i-mean-it.',
    );
    await handle.close();
    process.exit(1);
  }

  await applyMigrations(handle, { quiet: true });
  await handle.exec(`SET app.operator_id = 'seed';`);
  await truncateAll(handle);
  console.log(`seeding for ${TODAY_ISO} (America/Los_Angeles)`);
  await seed(handle);
  await handle.close();
}

if (isEntrypoint) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { seed };
