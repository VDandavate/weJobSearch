import { describe, expect, it } from 'vitest';
import { parseMasterProfile } from '../generators/resumeGenerator';
import { candidateCapabilitiesFromProfile } from './profileCapabilitiesExtractor';

const sampleProfile = `# Jane Sample

## Contact
- Email: jane@sample.example
- Location: Austin, TX

## Summary
Senior platform engineer with 8+ years of experience building distributed systems for fintech clients.

## Skills
- Languages: TypeScript, Rust, Python
- Infrastructure: AWS, Kubernetes, Docker, Terraform

## Experience
### Senior Engineer | SampleCorp | Remote
- Start: 2020
- End: 2026
- Built event-driven pipelines with Kafka.

## Education
### BS Computer Science | SampleState University
- Start: 2010
- End: 2014

## Certifications
- AWS Certified Developer
`;

describe('candidateCapabilitiesFromProfile', () => {
  it('derives skills from skills groups and certifications', () => {
    const candidate = candidateCapabilitiesFromProfile(parseMasterProfile(sampleProfile));
    expect(candidate.skills).toEqual([
      'TypeScript',
      'Rust',
      'Python',
      'AWS',
      'Kubernetes',
      'Docker',
      'Terraform',
      'AWS Certified Developer',
    ]);
  });

  it('reads years of experience from the profile summary language', () => {
    const candidate = candidateCapabilitiesFromProfile(parseMasterProfile(sampleProfile));
    expect(candidate.yearsOfExperience).toBe(8);
  });

  it('detects domains with the same taxonomy as posting requirements', () => {
    const candidate = candidateCapabilitiesFromProfile(parseMasterProfile(sampleProfile));
    expect(candidate.domains).toEqual(['FinTech']);
  });

  it('defaults missing signals to empty and zero', () => {
    const sparse = parseMasterProfile('# Someone\n\n## Summary\nSharp generalist.');
    const candidate = candidateCapabilitiesFromProfile(sparse);
    expect(candidate.skills).toEqual([]);
    expect(candidate.yearsOfExperience).toBe(0);
    expect(candidate.domains).toEqual([]);
  });
});