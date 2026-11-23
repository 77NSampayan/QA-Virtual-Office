/** Agent review verdicts (Pass P3). A review is a recommendation to a person; it never approves or rejects anything. */
export const REVIEW_VERDICTS = ['recommend_approve', 'changes_requested'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  recommend_approve: 'recommends approval',
  changes_requested: 'requests changes',
};
/** Filter values for the test-case list. "outdated" = the case changed after its latest review. */
export const REVIEW_FILTERS = ['recommend_approve', 'changes_requested', 'outdated', 'unreviewed'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];
export const MAX_REVIEW_NOTES = 2_000;
