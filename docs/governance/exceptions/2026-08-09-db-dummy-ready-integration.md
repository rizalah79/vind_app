# Governance Exception Record — DB Dummy-Ready Integration

Status: APPROVED BY CONTROL TOWER FOR CLOSURE WITHOUT HISTORY REWRITE  
Date: 2026-08-09  
Repository: `rizalah79/vind_app`

## Exception GE-2026-08-09-001 — Direct merge without PR

Approved database source:
`a61caefa19917995a9898a8006cab64d7c7398cb`

Direct merge commit:
`19168c64676c70a583c57166c01b13fd648025a6`

The database baseline was merged to `main` with a canonical `--no-ff` merge commit after explicit Control Tower approval, but no GitHub Pull Request object was created. This deviated from the repository governance rule that PR is the review/approval unit.

Disposition:
- accepted as a historical governance exception;
- no revert or history rewrite;
- technical database evidence remains valid;
- future `main` changes must use PR workflow.

## Exception GE-2026-08-09-002 — Direct post-merge `.gitattributes` commit

Commit:
`c2c2a1b76c26127ea7205a55f19c2829d733f760`

Change:
`*.sql text eol=lf`

Purpose:
prevent cross-platform SQL line-ending conversion from changing migration file checksums.

Disposition:
- accepted and retained;
- no revert;
- recorded as post-merge repository-hygiene exception;
- future repository-hygiene changes must use PR workflow.

## Compensating controls approved

For `main`:
- require changes through Pull Requests;
- block force pushes;
- block branch deletion;
- require conversation resolution;
- do not require CI status checks until canonical CI exists;
- do not require an external approving reviewer while the repository is operated by a single owner.

This file is implementation evidence of the Control Tower decision. It does not replace the canonical Decision Register if that register is maintained outside the repository.
