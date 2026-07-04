export type HandoffSection = 'Summary' | 'Actions' | 'Artifacts' | 'Risks' | 'Next';

export const HANDOFF_SECTIONS: readonly HandoffSection[] = ['Summary', 'Actions', 'Artifacts', 'Risks', 'Next'];

/** Actions does NOT carry forward — it describes what was done, not what persists */
export const CARRY_SECTIONS: readonly HandoffSection[] = ['Summary', 'Artifacts', 'Risks', 'Next'];

export interface ParsedHandoff {
  Summary: string;
  Actions: string;
  Artifacts: string;
  Risks: string;
  Next: string;
  /** true if at least one section heading was detected in the text */
  sawHeading: boolean;
}

export interface CarrySectionCaps {
  Summary: number;
  Artifacts: number;
  Risks: number;
  Next: number;
}

export const DEFAULT_CARRY_CAPS: CarrySectionCaps = {
  Summary: 900,
  Artifacts: 1600,
  Risks: 900,
  Next: 900,
};
