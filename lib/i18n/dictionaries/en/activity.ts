// Activity page: the audit log.
export const activity = {
  description: "The latest {limit} actions performed in Gantry.",
  columns: {
    at: "Time",
    username: "User",
    action: "Action",
    target: "Target",
  },
  searchPlaceholder: "Filter activity…",
  empty: "No activity yet.",
} as const
