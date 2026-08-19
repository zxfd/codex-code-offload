import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pasteProviderImages } from '../media-upload.mjs';

test('ChatGPT pastes every image and confirms the final distinct attachment count', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-media-upload-'));
  const files = Array.from({ length: 4 }, (_, index) => {
    const file = join(directory, `fixture-${index + 1}.png`);
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, index]));
    return file;
  });
  let attachments = 0;
  let writes = 0;
  const composer = {
    async click() {},
    async press(key) {
      assert.equal(key, 'ControlOrMeta+V');
      attachments += 1;
    },
  };
  const tab = {
    clipboard: {
      async write() { writes += 1; },
    },
    playwright: {
      async evaluate() {
        return { provider: 'ChatGPT', visibleAttachmentCount: attachments, visibleNames: [] };
      },
      async waitForTimeout() {},
    },
  };
  try {
    const result = await pasteProviderImages({ tab, provider: 'ChatGPT', imagePaths: files, composer });
    assert.equal(writes, 4);
    assert.equal(attachments, 4);
    assert.equal(result.ready, true);
    assert.equal(result.count, 4);
    assert.equal(result.state.visibleAttachmentCount, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
