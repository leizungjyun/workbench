# Development instructions

- Keep private workspaces, student records, import exports, credentials, and transcripts out of this public repository. Use synthetic fixtures only.
- Run `npm test` and `npm run build` for application changes, plus relevant Playwright checks for browser behavior. Review documentation changes and run `git diff --check`.
- Preserve unrelated changes. Review the staged diff and commit completed changes after validation.
- Rebuild browser assets after frontend changes. Restart after backend/configuration changes, checking active terminals and kernels before interrupting work. Verify live behavior; do not refresh a tab with unsaved drafts.
