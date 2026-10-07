import { describe, expect, it } from 'vitest';
import { compensationFromPosting, parseCompensation } from './compExtractor';
import { hitToRawPosting } from '../scrapers/adapters/hiringCafeAdapter';
import { jobToRawPosting as wttjJobToRawPosting } from '../scrapers/adapters/welcomeToTheJungleAdapter';
import { postingToRawPosting } from '../scrapers/adapters/builtInAdapter';
import { jobToRawPosting as wellfoundJobToRawPosting } from '../scrapers/adapters/wellfoundAdapter';
import { recordToRawPosting } from '../scrapers/adapters/flexJobsAdapter';
import type { RawPosting } from '../scrapers/jobSpyAdapter';

function posting(overrides: Partial<RawPosting>): RawPosting {
  return {
    sourceAggregator: 'test',
    companyName: 'SampleCorp',
    roleTitle: 'Senior Engineer',
    location: 'Remote',
    jobUrl: 'https://example.com/job',
    description: 'Body',
    hasFullDescription: true,
    postedAt: null,
    ...overrides,
  };
}

describe('compExtractor', () => {
  it('returns null for absent rawSalaryText instead of throwing', () => {
    expect(parseCompensation(undefined)).toBeNull();
    expect(parseCompensation(null)).toBeNull();
    expect(parseCompensation('')).toBeNull();
    expect(parseCompensation('   ')).toBeNull();
    expect(compensationFromPosting(posting({ rawSalaryText: undefined }))).toBeNull();
  });

  it('parses the hiringCafe committed format "USD 160,000-190,000/yr"', () => {
    const source = hitToRawPosting(
      {
        jobTitle: 'Senior Engineer',
        requisitionId: '1234',
        hcPinnedSlug: 'senior-engineer-1234',
        v6ProcessedJobData: {
          coreJobTitle: 'Senior Engineer',
          companyName: 'SampleCorp',
          formattedWorkplaceLocation: 'Remote',
          listedCompensationCurrency: 'USD',
          listedCompensationFrequency: 'yearly',
          yearlyMinCompensation: 160000,
          yearlyMaxCompensation: 190000,
        },
        jobInformation: { title: 'Senior Engineer', description: 'Body' },
        enrichedCompanyData: { name: 'SampleCorp' },
      },
      new Map(),
    );
    expect(source).not.toBeNull();
    expect(compensationFromPosting(source!)).toEqual({
      currency: 'USD',
      minAmount: 160000,
      maxAmount: 190000,
      period: 'year',
    });
  });

  it('parses the WTTJ committed format "Salary: EUR 45,000 - 55,000 (per year)"', () => {
    const source = wttjJobToRawPosting({
      name: 'Data Scientist',
      slug: 'data-scientist',
      organization: { name: 'SampleCorp', websiteOrgSlug: 'samplecorp' },
      salaryCurrency: 'EUR',
      salaryMin: 45000,
      salaryMax: 55000,
    });
    expect(source).not.toBeNull();
    expect(compensationFromPosting(source!)).toEqual({
      currency: 'EUR',
      minAmount: 45000,
      maxAmount: 55000,
      period: 'year',
    });
  });

  it('maps WTTJ per-hour and per-month labels and USD symbol correctly', () => {
    const source = wttjJobToRawPosting({
      name: 'Data Scientist',
      slug: 'data-scientist',
      organization: { name: 'SampleCorp', websiteOrgSlug: 'samplecorp' },
      salaryCurrency: 'USD',
      salaryMin: 70000,
      salaryMax: 90000,
    });
    expect(compensationFromPosting(source!)).toEqual({
      currency: 'USD',
      minAmount: 70000,
      maxAmount: 90000,
      period: 'year',
    });
  });

  it('maps WTTJ per-hour to period hour', () => {
    const compensation = parseCompensation('Salary: USD 30 - 45 (per hour)');
    expect(compensation).toEqual({
      currency: 'USD',
      minAmount: 30,
      maxAmount: 45,
      period: 'hour',
    });
  });

  it('parses the builtIn committed format "USD 120,000 - 225,000 per year"', () => {
    const source = postingToRawPosting(
      {
        title: 'Senior Engineer',
        hiringOrganization: { name: 'SampleCorp' },
        identifier: { value: '123456' },
        baseSalary: { currency: 'USD', value: { minValue: 120000, maxValue: 225000, unitText: 'YEAR' } },
      },
      'https://builtin.com/job/devops-engineer-123456',
    );
    expect(source).not.toBeNull();
    expect(compensationFromPosting(source!)).toEqual({
      currency: 'USD',
      minAmount: 120000,
      maxAmount: 225000,
      period: 'year',
    });
  });

  it('parses the flexJobs committed raw salaryRange "68,000 - 85,000 USD Annually"', () => {
    const source = recordToRawPosting({
      title: 'Support Technician',
      slug: 'support-technician',
      salaryRange: '68,000 - 85,000 USD Annually',
      company: { name: 'SampleCorp' },
    });
    expect(source).not.toBeNull();
    expect(compensationFromPosting(source!)).toEqual({
      currency: 'USD',
      minAmount: 68000,
      maxAmount: 85000,
      period: 'year',
    });
  });

  it('maps flexJobs quarterly salary labels shifts to period unknown', () => {
    const compensation = parseCompensation('50,000 - 70,000 USD Quarterly');
    expect(compensation).toEqual({
      currency: 'USD',
      minAmount: 50000,
      maxAmount: 70000,
      period: 'unknown',
    });
  });

  it('returns null absence for a wellfound posting (no rawSalaryText committed)', () => {
    const source = wellfoundJobToRawPosting(
      { name: 'StartupCo' },
      { compensation: '$310k - $345k', description: 'Body', id: '45', slug: 'engineer', title: 'Engineer' },
    );
    expect(source).not.toBeNull();
    expect(source!.description).toContain('$310k');
    expect(compensationFromPosting(source!)).toBeNull();
  });

  it('handles single-value ranges as bound minimum', () => {
    const compensation = parseCompensation('USD 160,000/yr');
    expect(compensation).toEqual({
      currency: 'USD',
      minAmount: 160000,
      maxAmount: 160000,
      period: 'year',
    });
  });

  it('parses lower-cased budget/currency-mixed text', () => {
    const compensation = parseCompensation('salary: eur 45,000-55,000 (per year)');
    expect(compensation).toEqual({
      currency: 'EUR',
      minAmount: 45000,
      maxAmount: 55000,
      period: 'year',
    });
  });
});