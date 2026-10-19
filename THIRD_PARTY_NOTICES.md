# Third-party components

- Node.js packages: versions and integrity hashes are recorded in `package-lock.json`; package licenses accompany each dependency when installed through npm.
- Electron: downloaded by npm; its license and Chromium notices accompany the installed Electron distribution.
- Embedded CPython 3.12 for Windows: distributed under the Python Software Foundation license and included third-party notices in `vendor/python/LICENSE.txt`.
- Python packages in `vendor/pydeps/`: license and package metadata remain in their corresponding `*.dist-info` directories.
- `edge-tts` protocol support: corresponding Java implementation and upstream LGPL notices are preserved in `web/licenses/edge-tts/`. The original Python package and license metadata are in `vendor/pydeps/`.
- Android platform APIs and build tools: supplied separately through the Android SDK; not included in this source repository.

The public Edge Read Aloud client identifier in the implementation is a protocol constant, not a user's private API credential. Voice services are provided by their respective operators and require a working network connection.
