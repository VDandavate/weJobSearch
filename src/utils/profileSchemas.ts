import { z } from 'zod';

// Neutral home for the shared profile-setup schemas (Phase 5b layering fix).
// Primary path: the MCP profile tools (getUserProfile / initializeUserProfile
// / updateUserProfile) via profileService.ts. Fallback: the init wizard
// (initWizard.ts) for developers. Both import from here; neither owns the
// schema, so a schema change lands once instead of diverging across two
// builders.

export const screeningAnswersSchema = z.object({
  workAuthorization: z.object({
    usCitizen: z.boolean(),
    requiresSponsorship: z.boolean(),
    sponsorshipType: z.string().nullable(),
  }),
  compensation: z.object({
    minBaseSalary: z.number(),
    targetBaseSalary: z.number(),
    currency: z.string(),
  }),
  standardQuestions: z.object({
    yearsOfExperience: z.record(z.string(), z.number()),
    preferredWorkLocation: z.string(),
    noticePeriod: z.string(),
  }),
});

export type ScreeningAnswers = z.infer<typeof screeningAnswersSchema>;
