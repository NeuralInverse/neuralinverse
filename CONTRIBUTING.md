# Contributing to NeuralInverse CE

Thank you for your interest in contributing! NeuralInverse CE is open source and we welcome contributions of all kinds.

## Ways to contribute

- Report bugs via [GitHub Issues](https://github.com/NeuralInverse/neuralinverse/issues)
- Suggest features or improvements
- Submit pull requests for bug fixes or new CE features
- Improve documentation

## Getting started

1. Fork the repo and clone it locally
2. Install dependencies: `npm install`
3. Build: `npm run compile`
4. Make your changes on a new branch
5. Test your changes
6. Open a pull request against `main`

See [HOW_TO_CONTRIBUTE.md](./HOW_TO_CONTRIBUTE.md) for full platform-specific setup instructions.

## Pull request guidelines

- Keep PRs focused - one feature or fix per PR
- Write a clear description of what changed and why
- Make sure the build passes before submitting
- No non-ASCII characters in TypeScript/JavaScript string literals (build will fail)

## Scope of CE contributions

CE contributions should be limited to:
- AI chat and agentic workflows (`contrib/void/`, `contrib/powerMode/`)
- Modernization engine (`contrib/neuralInverseModernisation/`)
- Firmware tooling (`contrib/neuralInverseFirmware/`)
- General IDE improvements

Enterprise features (Checks, GRC, compliance engine, auth) are not part of this repo.

## Questions?

Open an issue or email github@neuralinverse.com.
