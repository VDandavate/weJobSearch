import { describe, expect, it, vi } from 'vitest';
import type { CandidateCapabilities } from './fitEvaluator';
import { suggestRoles } from './roleSuggester';

// ---------------------------------------------------------------------------
// Fixtures (synthetic capabilities triples, no I/O anywhere in this file)
// ---------------------------------------------------------------------------

const frontendCapabilities: CandidateCapabilities = {
  skills: ['TypeScript', 'React', 'JavaScript', 'Node.js'],
  yearsOfExperience: 6,
  domains: [],
};

const juniorFrontendCapabilities: CandidateCapabilities = {
  skills: ['TypeScript', 'React'],
  yearsOfExperience: 2,
  domains: [],
};

const staffFrontendCapabilities: CandidateCapabilities = {
  skills: ['TypeScript', 'React'],
  yearsOfExperience: 8,
  domains: [],
};

const securityDomainCapabilities: CandidateCapabilities = {
  skills: ['Python'],
  yearsOfExperience: 5,
  domains: ['Cybersecurity'],
};

const emptyCapabilities: CandidateCapabilities = {
  skills: [],
  yearsOfExperience: 0,
  domains: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('suggestRoles', () => {
  it('is deterministic: identical input yields identical output across calls', () => {
    const first = suggestRoles(frontendCapabilities);
    const second = suggestRoles(frontendCapabilities);
    expect(second).toEqual(first);
    // Input array order must not matter: shuffled skills produce the same list.
    const shuffled = suggestRoles({
      ...frontendCapabilities,
      skills: ['React', 'Node.js', 'JavaScript', 'TypeScript'],
    });
    expect(shuffled).toEqual(first);
  });

  it('maps known skills to role titles with a seniority qualifier', () => {
    const suggestions = suggestRoles(frontendCapabilities);
    expect(suggestions).toContain('Senior Frontend Engineer');
    expect(suggestions).toContain('Senior Full-Stack Engineer');
  });

  it('derives seniority qualifiers from years of experience', () => {
    expect(suggestRoles(juniorFrontendCapabilities)).toContain('Frontend Engineer');
    expect(suggestRoles(juniorFrontendCapabilities)).not.toContain('Senior Frontend Engineer');
    expect(suggestRoles(staffFrontendCapabilities)).toContain('Staff Frontend Engineer');
    expect(suggestRoles(staffFrontendCapabilities)).not.toContain('Senior Frontend Engineer');
  });

  it('appends domain-backed role titles when the taxonomy supports the domain', () => {
    const withDomain = suggestRoles(securityDomainCapabilities);
    expect(withDomain).toContain('Senior Security Engineer');
    const withoutDomain = suggestRoles({ ...securityDomainCapabilities, domains: [] });
    expect(withoutDomain).not.toContain('Security Engineer');
  });

  it('returns an empty list for an empty profile without error', () => {
    expect(suggestRoles(emptyCapabilities)).toEqual([]);
  });

  it('never invents roles for unknown skills', () => {
    const unknown = suggestRoles({
      skills: ['QuantumWeaving', 'NebulaForge'],
      yearsOfExperience: 5,
      domains: [],
    });
    expect(unknown).toEqual([]);
  });

  it('is a pure function: synchronous, no I/O, no network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = suggestRoles(frontendCapabilities);
      expect(result).not.toBeInstanceOf(Promise);
      expect(Array.isArray(result)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});