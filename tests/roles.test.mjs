import { readFile } from 'node:fs/promises';
import {
  ROLES,
  ALL_ROLES,
  ROLE_INDEX,
  ROLE_MOVE,
  TRANSITIONS,
  LANE_CLAIM_ROLES,
  DEV_ROLES,
  DEFAULT_MEMBERS,
  composeAgentPrompt,
  rolePlaybookText,
  buildSkillContent,
  personaTemplate,
} from '../roles.js';

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

const COLUMN_IDS = ['backlog', 'ready', 'in_progress', 'review', 'done'];
const expectedRoles = [
  'product-manager',
  'ux-designer',
  'fe-developer',
  'be-developer',
  'fullstack-developer',
  'bug-fixer',
  'reviewer',
  'tester',
  'sre',
  'tech-lead',
];

// --- catalog shape ---------------------------------------------------------
check('ten roles', ROLES.length === 10, String(ROLES.length));
check('role ids exact', JSON.stringify(ALL_ROLES) === JSON.stringify(expectedRoles), ALL_ROLES.join(','));
check('unique role ids', new Set(ALL_ROLES).size === 10);
check(
  'role names unique',
  new Set(ROLES.map((role) => role.name)).size === 10,
  ROLES.map((role) => role.name).join(','),
);
check('ROLE_INDEX complete', ALL_ROLES.every((id) => ROLE_INDEX[id]?.id === id));
check(
  'role basics',
  ROLES.every(
    (role) =>
      typeof role.name === 'string' &&
      role.name.length > 2 &&
      typeof role.description === 'string' &&
      role.description.length >= 30 &&
      typeof role.summary === 'string' &&
      role.summary.length > 10 &&
      role.summary.length <= 120 &&
      Array.isArray(role.claimColumns) &&
      role.claimColumns.every((column) => COLUMN_IDS.includes(column)) &&
      typeof role.canCreate === 'boolean' &&
      typeof role.canOverride === 'boolean',
  ),
);
check('bug-fixer is present', ALL_ROLES.includes('bug-fixer'));
check('only tech-lead overrides', ROLES.filter((role) => role.canOverride).map((role) => role.id).join(',') === 'tech-lead');
check('tech-lead claims every column', JSON.stringify(ROLE_INDEX['tech-lead'].claimColumns) === JSON.stringify(COLUMN_IDS));

// --- policy tables ---------------------------------------------------------
check('ROLE_MOVE covers every role', ALL_ROLES.every((id) => Array.isArray(ROLE_MOVE[id]) && ROLE_MOVE[id].length > 0));
check(
  'ROLE_MOVE edges reference valid columns',
  ALL_ROLES.every((id) =>
    ROLE_MOVE[id].every((edge) => edge === '*' || edge.split('>').every((column) => COLUMN_IDS.includes(column))),
  ),
);
check(
  'DEV_ROLES includes bug-fixer and developers',
  ['fe-developer', 'be-developer', 'fullstack-developer', 'bug-fixer'].every((id) => DEV_ROLES.has(id)),
);
check(
  'bug-fixer claims Ready and moves ready→in_progress→review',
  LANE_CLAIM_ROLES.ready.includes('bug-fixer') &&
    ROLE_MOVE['bug-fixer'].includes('ready>in_progress') &&
    ROLE_MOVE['bug-fixer'].includes('in_progress>review') &&
    ROLE_MOVE['bug-fixer'].includes('in_progress>ready'),
);
check('bug-fixer cannot accept Review → Done', !ROLE_MOVE['bug-fixer'].includes('review>done'));
check(
  'transitions table intact',
  TRANSITIONS.length === 8 &&
    TRANSITIONS.every(
      (transition) =>
        COLUMN_IDS.includes(transition.from) &&
        COLUMN_IDS.includes(transition.to) &&
        Array.isArray(transition.allowedRoles) &&
        transition.allowedRoles.length > 0 &&
        transition.allowedRoles.every((role) => ALL_ROLES.includes(role)),
    ),
);
check(
  'bug-fixer may pull Ready work',
  TRANSITIONS.filter((transition) => transition.from === 'ready' && transition.to === 'in_progress')[0]?.allowedRoles.includes('bug-fixer') === true,
);
check(
  'review gate unchanged',
  TRANSITIONS.filter((transition) => transition.to === 'done').every((transition) => !transition.allowedRoles.includes('bug-fixer')),
);

// --- playbook rigor (§5.3) -------------------------------------------------
const discipline = {
  dor: /definition of ready|\bdor\b/i,
  evidence: /evidence|artifact/i,
  askUser: /ask (the )?user|ask once|genuinely ambiguous|ask now|user question/i,
  blockOrEscalate: /block|escalat/i,
  decisions: /decision|comment/i,
  oneColumn: /one column|one ticket|one at a time|single column|one vertical slice|one owned slice/i,
};

for (const role of ROLES) {
  const playbook = role.playbook;
  const label = role.id;
  check(`${label}: playbook shape`, Boolean(playbook) && typeof playbook.mission === 'string' && playbook.mission.length >= 40);
  check(`${label}: inputs >= 2`, Array.isArray(playbook.inputs) && playbook.inputs.length >= 2 && playbook.inputs.every((input) => typeof input === 'string' && input.length > 5));
  check(`${label}: 8–12 steps`, Array.isArray(playbook.steps) && playbook.steps.length >= 8 && playbook.steps.length <= 12, String(playbook.steps.length));
  check(
    `${label}: step fields`,
    playbook.steps.every(
      (step) =>
        typeof step.title === 'string' &&
        step.title.trim().split(/\s+/).length >= 3 &&
        typeof step.detail === 'string' &&
        step.detail.length >= 40 &&
        Array.isArray(step.artifacts) &&
        step.artifacts.length >= 1 &&
        step.artifacts.every((artifact) => typeof artifact === 'string' && artifact.length > 2) &&
        (step.gate === '' || typeof step.gate === 'string'),
    ),
  );
  check(
    `${label}: explicit gates`,
    playbook.steps.filter((step) => typeof step.gate === 'string' && step.gate.length > 0).length >= 2,
    String(playbook.steps.filter((step) => step.gate).length),
  );
  check(`${label}: ask-user rules >= 2`, Array.isArray(playbook.askUserWhen) && playbook.askUserWhen.length >= 2 && playbook.askUserWhen.every((rule) => typeof rule === 'string' && rule.length > 10));
  check(`${label}: escalation`, typeof playbook.escalation === 'string' && playbook.escalation.length >= 20);
  check(
    `${label}: role DoD >= 6`,
    Array.isArray(playbook.definitionOfDone) &&
      playbook.definitionOfDone.length >= 6 &&
      playbook.definitionOfDone.every((item) => typeof item === 'string' && item.length > 10),
    String(playbook.definitionOfDone.length),
  );
  const playbookText = JSON.stringify(playbook);
  const missingDiscipline = Object.entries(discipline)
    .filter(([, pattern]) => !pattern.test(playbookText))
    .map(([key]) => key);
  check(`${label}: shared discipline`, missingDiscipline.length === 0, missingDiscipline.join(','));
}

// --- bug-fixer reference playbook (§5.4) -----------------------------------
const bugFixer = ROLE_INDEX['bug-fixer'];
check('bug-fixer has exactly 11 phases', bugFixer.playbook.steps.length === 11, String(bugFixer.playbook.steps.length));
check('bug-fixer gates >= 4', bugFixer.playbook.steps.filter((step) => step.gate).length >= 4);
const phaseTitles = bugFixer.playbook.steps.map((step) => step.title.toLowerCase());
const phases = {
  intake: /intake|charter/,
  baseline: /worktree|baseline/,
  repro: /pre-state|capture|repro/,
  rootCause: /root cause/,
  blastRadius: /blast radius/,
  fixPlan: /fix plan/,
  implementation: /implement|land the fix|one owned/,
  verify: /verify|post-state/,
  consistency: /consistency|global/,
  quality: /quality/,
  report: /report|hand off/,
};
const missingPhases = Object.entries(phases).filter(([, pattern]) => !phaseTitles.some((title) => pattern.test(title))).map(([key]) => key);
check('bug-fixer phase coverage', missingPhases.length === 0, missingPhases.join(','));
check(
  'bug-fixer captures evidence conventions',
  /before\/|after\/|screenshot|failing test|logs|ledger|database/i.test(JSON.stringify(bugFixer.playbook)),
);

// --- no copied playbooks ---------------------------------------------------
const titleSets = ROLES.map((role) => new Set(role.playbook.steps.map((step) => step.title.toLowerCase())));
let maxOverlap = 0;
let overlapPair = '';
for (let left = 0; left < titleSets.length; left += 1) {
  for (let right = left + 1; right < titleSets.length; right += 1) {
    const shared = [...titleSets[left]].filter((title) => titleSets[right].has(title));
    if (shared.length > maxOverlap) {
      maxOverlap = shared.length;
      overlapPair = `${ROLES[left].id}/${ROLES[right].id}:${shared.join('|')}`;
    }
  }
}
check('playbooks are not copies', maxOverlap === 0, overlapPair);
const missionSets = new Set(ROLES.map((role) => role.playbook.mission));
check('missions are distinct', missionSets.size === 10);

// --- default roster personas (§6.2) ----------------------------------------
check('ten default members', DEFAULT_MEMBERS.length === 10, String(DEFAULT_MEMBERS.length));
check('one member per role', new Set(DEFAULT_MEMBERS.map((member) => member.roleId)).size === 10);
check('deterministic member ids', DEFAULT_MEMBERS.every((member) => member.id === `member-${member.roleId}`));
check(
  'default members complete',
  DEFAULT_MEMBERS.every(
    (member) =>
      ALL_ROLES.includes(member.roleId) &&
      typeof member.name === 'string' &&
      member.name.trim().split(/\s+/).length >= 2 &&
      typeof member.title === 'string' &&
      member.title.length >= 3,
  ),
);
check(
  'default names unique',
  new Set(DEFAULT_MEMBERS.map((member) => member.name.trim().toLowerCase())).size === 10,
  DEFAULT_MEMBERS.map((member) => member.name).join(','),
);
const personaWords = (persona) => persona.trim().split(/\s+/).length;
check(
  'persona length 100–180 words',
  DEFAULT_MEMBERS.every((member) => personaWords(member.persona) >= 100 && personaWords(member.persona) <= 180),
  DEFAULT_MEMBERS.map((member) => personaWords(member.persona)).join(','),
);
check(
  'personas are second person and non-empty',
  DEFAULT_MEMBERS.every((member) => /\byou\b|\byour\b/i.test(member.persona) && member.persona.length > 500),
);
const shingles = (text, size = 8) => {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set();
  for (let index = 0; index + size <= words.length; index += 1) set.add(words.slice(index, index + size).join(' '));
  return set;
};
let sharedShingles = 0;
let sharedExample = '';
const personaGrams = DEFAULT_MEMBERS.map((member) => shingles(member.persona));
for (let left = 0; left < personaGrams.length; left += 1) {
  for (let right = left + 1; right < personaGrams.length; right += 1) {
    const shared = [...personaGrams[left]].filter((gram) => personaGrams[right].has(gram));
    if (shared.length > 0) {
      sharedShingles += 1;
      if (!sharedExample) sharedExample = `${DEFAULT_MEMBERS[left].name}/${DEFAULT_MEMBERS[right].name}: ${shared[0]}`;
    }
  }
}
check('personas share no long phrases', sharedShingles === 0, sharedExample);
check(
  'specialists read as different people',
  DEFAULT_MEMBERS.filter((member) => ['bug-fixer', 'fullstack-developer', 'tech-lead'].includes(member.roleId)).every((member) =>
    /root cause|forensic|repro|evidence|breadth|vertical|arbitrat|flow|specialist|generalist/i.test(member.persona),
  ),
);
const templates = ROLES.map((role) => personaTemplate(role.id));
check(
  'persona templates valid',
  templates.every((persona) => typeof persona === 'string' && personaWords(persona) >= 100 && personaWords(persona) <= 180 && /\byou\b|\byour\b/i.test(persona)),
  templates.map(personaWords).join(','),
);

// --- prompt composition (§D5) ----------------------------------------------
const member = DEFAULT_MEMBERS.find((candidate) => candidate.roleId === 'bug-fixer');
const ticket = { id: 'KB-99', title: 'Fix the crash', column: 'ready', priority: 'high', role: 'bug-fixer', description: 'Saving crashes.' };
const composed = composeAgentPrompt({ role: ROLE_INDEX['bug-fixer'], member, ticket });
check('composed prompt: role playbook', composed.includes(bugFixer.playbook.mission) && composed.includes(bugFixer.playbook.steps[0].title));
check('composed prompt: role DoD', composed.includes(bugFixer.playbook.definitionOfDone[0]));
check('composed prompt: persona', composed.includes(member.persona));
check('composed prompt: ticket context', composed.includes('KB-99') && /ticket context/i.test(composed));
check('composed prompt: order playbook before persona before ticket', composed.indexOf(bugFixer.playbook.mission) < composed.indexOf(member.persona) && composed.indexOf(member.persona) < composed.indexOf('KB-99'));
const composedById = composeAgentPrompt({ role: 'bug-fixer', member: null, ticket: null });
check('composed prompt accepts role id', composedById.includes('Bug Fixer') && composedById.includes('Definition of Done'));
check('composed prompt degrades gracefully', composeAgentPrompt({}) === '' || composeAgentPrompt({}) === undefined);
check('playbook text contains steps and DoD', rolePlaybookText(bugFixer).includes(bugFixer.playbook.steps[0].title) && rolePlaybookText(bugFixer).includes('Definition of Done'));

// --- generated skill cannot drift ------------------------------------------
const skill = buildSkillContent();
check('skill mentions every role name', ROLES.every((role) => skill.includes(role.name)));
check('skill mentions every role id', ALL_ROLES.every((id) => skill.includes(id)));
check(
  'skill contains every role DoD item',
  ROLES.every((role) => role.playbook.definitionOfDone.every((item) => skill.includes(item))),
  ROLES.filter((role) => !role.playbook.definitionOfDone.every((item) => skill.includes(item))).map((role) => role.id).join(','),
);
check('skill keeps the pull loop', skill.includes('whoami') && skill.includes('claim') && skill.includes('Definition of Ready'));
check('skill explains roles vs members', /roles? .*members?|members? .*roles?/i.test(skill) && /persona/i.test(skill));

// --- host wiring: catalog is the single source -----------------------------
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
check('host imports the catalog', /from '\.\/roles\.js'/.test(indexSource) && /DEFAULT_MEMBERS/.test(indexSource));
check(
  'host has no duplicated role list',
  !/const ALL_ROLES = \[/.test(indexSource) &&
    !/const ROLES = \[/.test(indexSource) &&
    !/const ROLE_MOVE = \{/.test(indexSource) &&
    !/const TRANSITIONS = \[/.test(indexSource),
);
check('host generates the skill from the catalog', /buildSkillContent\(\)/.test(indexSource));
check('host composes dispatch prompts', /composeAgentPrompt\(/.test(indexSource));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
check('roles.js shipped in package files', Array.isArray(packageJson.files) && packageJson.files.includes('roles.js'));

console.log('\n' + (failures.length === 0 ? 'ALL ROLE CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
process.exit(failures.length === 0 ? 0 : 1);
