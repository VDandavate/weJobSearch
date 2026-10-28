import type { SetupAnswers } from '../core/setupPlan';

// Synthetic setup answers used by the setup-question tests. Deliberately
// mirrors fixtures/sampleProfile.md (Jane Sample, SampleCorp) so no real
// person's data appears anywhere in the suite.
export const setupFixtureAnswers: SetupAnswers = {
  contactName: 'Jane Sample',
  contactEmail: 'jane.sample@example.com',
  contactPhone: '+1 555 0100',
  contactCityState: 'Austin, TX',
  contactLinkedIn: 'https://linkedin.com/in/janesample',
  contactPortfolio: 'https://janesample.dev',
  summary: 'Senior platform engineer with 8+ years of experience.',
  skills: [{ category: 'Languages', items: ['TypeScript', 'Rust'] }],
  experience: [
    {
      roleTitle: 'Senior Platform Engineer',
      employer: 'AcmeCorp',
      location: 'San Francisco, CA',
      startDate: '2021-03',
      endDate: 'Present',
      bullets: ['Led the migration of 200+ microservices to Kubernetes.'],
    },
  ],
  education: [
    {
      degree: 'BS Computer Science',
      institution: 'SampleState University',
      startYear: '2010',
      endYear: '2014',
    },
  ],
  certifications: ['AWS Certified Developer'],
  usCitizen: true,
  requiresSponsorship: false,
  clearanceStatus: 'none',
  targetRoles: ['Staff Engineer'],
  preferredLocations: ['Remote'],
  minAcceptableBase: 150000,
  targetBase: 180000,
  currency: 'USD',
  countsBonusTowardMin: false,
  countsEquityTowardMin: false,
  noRelocation: false,
  remoteOnly: false,
  noStaffingAgencies: false,
  clearanceMismatch: false,
  belowMinSalary: false,
  noticePeriod: '2 weeks',
};
