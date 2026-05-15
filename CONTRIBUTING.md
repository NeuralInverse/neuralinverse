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

## AI-assisted contributions (BYOLLM)

NeuralInverse is a BYOLLM (Bring Your Own LLM) platform. If you used AI assistance, include TWO `Co-authored-by` trailers in your commit message footer:

1. **Always include the NeuralInverse platform trailer:**
```
Co-authored-by: neuralinverse-dev <noreply@neuralinverse.com>
```

2. **Plus the specific LLM you used:**

| Model | Trailer |
|---|---|
| Claude (Anthropic) | `Co-authored-by: Claude <noreply@anthropic.com>` |
| ChatGPT / GPT-4 (OpenAI) | `Co-authored-by: ChatGPT <noreply@openai.com>` |
| Gemini (Google) | `Co-authored-by: Gemini <noreply@google.com>` |
| Custom / self-hosted | `Co-authored-by: [Model Name] <your-contact-email>` |

Example commit message footer:

```
fix: resolve null pointer in session service

Co-authored-by: neuralinverse-dev <noreply@neuralinverse.com>
Co-authored-by: Claude <noreply@anthropic.com>
```

This gives proper attribution and helps the community understand how AI tooling is being used in the project.

## Questions?

Open an issue or email github@neuralinverse.com.
