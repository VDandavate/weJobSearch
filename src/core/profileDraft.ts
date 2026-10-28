import type { ProfileInitializationInput } from '../utils/profileService';

// Deterministic plain-text renderer for a profile draft (setupQuestionCursor
// T02). The setup question payloads and the directive's preview step use this
// instead of dumping markdown or JSON at the user. Fixed layout: aligned label
// pairs for contact, one line per experience or education entry, and an
// explicit "not provided (optional)" for empty optional links.

export type ProfileDraftSection =
  | 'contact'
  | 'workAuthorization'
  | 'summary'
  | 'skills'
  | 'experience'
  | 'education'
  | 'certifications';

const labelWidth = 14;

function row(label: string, value: string): string {
  return `  ${label.padEnd(labelWidth)}${value}`;
}

function sectionHeading(title: string): string {
  return `${title}\n${'-'.repeat(title.length)}`;
}

function orNotProvided(value: string): string {
  return value.trim().length > 0 ? value : 'not provided (optional)';
}

function contactLines(input: ProfileInitializationInput): string[] {
  const { contact } = input.masterProfile;
  return [
    sectionHeading('Contact'),
    row('Name', contact.name),
    row('Email', contact.email),
    row('Phone', contact.phone),
    row('City / State', contact.cityState),
    row('LinkedIn', orNotProvided(contact.linkedIn)),
    row('Portfolio', orNotProvided(contact.portfolio)),
  ];
}

function workAuthorizationLines(input: ProfileInitializationInput): string[] {
  const auth = input.masterProfile.workAuthorization;
  return [
    sectionHeading('Work authorization'),
    row('US Citizen', auth.usCitizen),
    row('Sponsorship', auth.requiresSponsorship),
    row('Clearance', auth.clearance),
  ];
}

function summaryLines(input: ProfileInitializationInput): string[] {
  return [sectionHeading('Summary'), `  ${input.masterProfile.summary}`];
}

function skillsLines(input: ProfileInitializationInput): string[] {
  const lines = [sectionHeading('Skills')];
  if (input.masterProfile.skills.length === 0) {
    lines.push('  not provided (optional)');
  } else {
    for (const group of input.masterProfile.skills) {
      lines.push(row(group.category, group.items.join(', ')));
    }
  }
  return lines;
}

function experienceLines(input: ProfileInitializationInput): string[] {
  const lines = [sectionHeading('Experience')];
  if (input.masterProfile.experience.length === 0) {
    lines.push('  not provided (optional)');
  } else {
    for (const entry of input.masterProfile.experience) {
      lines.push(
        `  ${entry.roleTitle} | ${entry.employer} | ${entry.location} | ${entry.startDate} - ${entry.endDate}`,
      );
    }
  }
  return lines;
}

function educationLines(input: ProfileInitializationInput): string[] {
  const lines = [sectionHeading('Education')];
  if (input.masterProfile.education.length === 0) {
    lines.push('  not provided (optional)');
  } else {
    for (const entry of input.masterProfile.education) {
      lines.push(
        `  ${entry.degree} | ${entry.institution} | ${entry.startYear} - ${entry.endYear}`,
      );
    }
  }
  return lines;
}

function certificationsLines(input: ProfileInitializationInput): string[] {
  const lines = [sectionHeading('Certifications')];
  if (input.masterProfile.certifications.length === 0) {
    lines.push('  not provided (optional)');
  } else {
    for (const certification of input.masterProfile.certifications) {
      lines.push(`  ${certification}`);
    }
  }
  return lines;
}

const sectionRenderers: Record<ProfileDraftSection, (input: ProfileInitializationInput) => string[]> = {
  contact: contactLines,
  workAuthorization: workAuthorizationLines,
  summary: summaryLines,
  skills: skillsLines,
  experience: experienceLines,
  education: educationLines,
  certifications: certificationsLines,
};

export function renderProfileSection(
  section: ProfileDraftSection,
  input: ProfileInitializationInput,
): string {
  return `${sectionRenderers[section](input).join('\n')}\n`;
}

export function renderProfileDraft(input: ProfileInitializationInput): string {
  const order: readonly ProfileDraftSection[] = [
    'contact',
    'workAuthorization',
    'summary',
    'skills',
    'experience',
    'education',
    'certifications',
  ];
  return `${order.map((section) => renderProfileSection(section, input)).join('\n')}`;
}
