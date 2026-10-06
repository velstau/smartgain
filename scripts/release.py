#!/usr/bin/env python3
"""配布用 zip を作る。

使い方（リポジトリ直下で）:
    python3 scripts/release.py            # dist/smartgain-<版>.zip を作る
    python3 scripts/release.py --publish  # さらに vel.works の紹介ページのフォルダへ置く

リポジトリ直下がそのまま拡張のフォルダ。zip の中身は「smartgain/」フォルダ 1 つで、
利用者は展開したそのフォルダを chrome://extensions の「パッケージ化されていない拡張機能を読み込む」で選ぶ。
LICENSE は同梱する（MIT の条件）。テスト・文書・スクリプト・実データは入れない。

--publish の置き場所は環境変数 VELWORKS（既定は開発サーバーの vel.works）。
古い版の zip は消す（過去の版は git のタグから作り直せる）。
"""
import json
import os
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # リポジトリ直下 = 拡張のフォルダ
NAME = 'smartgain'  # zip の中のフォルダ名・紹介ページの URL（clone したフォルダ名には依存しない）
EXCLUDE_DIRS = {'tests', 'test', 'docs', 'samples', 'scripts', 'dist', '__pycache__', 'node_modules'}
EXCLUDE_SUFFIXES = {'.md', '.pem', '.py'}
VELWORKS = Path(os.environ.get('VELWORKS', '/var/docker/docker-shared/dev-server-php8/vel.works'))


def fail(msg):
    print(f'エラー: {msg}', file=sys.stderr)
    sys.exit(1)


def runtime_files(ext_dir):
    for path in sorted(ext_dir.rglob('*')):
        rel = path.relative_to(ext_dir)
        # .git などの隠しフォルダの中身も除く（名前が . で始まる部分がパスのどこかにあれば対象外）
        if path.is_dir() or rel.parts[0] in EXCLUDE_DIRS or path.suffix in EXCLUDE_SUFFIXES or any(part.startswith('.') for part in rel.parts):
            continue
        yield path, rel


def check(name, ext_dir, manifest):
    if 'key' not in manifest:
        fail('manifest.json に key がない（拡張 ID が固定されず、更新のたびに利用者のデータが消える）')
    if name == 'smartgain':
        # デバッグ表示の版と manifest の版がずれていないか
        m = re.search(r"const AGC_VERSION = '([^']+)'", (ext_dir / 'inject.js').read_text(encoding='utf-8'))
        if not m or m.group(1) != manifest['version']:
            fail(f"inject.js の AGC_VERSION ({m and m.group(1)}) が manifest の版 ({manifest['version']}) と違う")


def main():
    publish = '--publish' in sys.argv
    name = NAME
    ext_dir = ROOT
    manifest = json.loads((ext_dir / 'manifest.json').read_text(encoding='utf-8'))
    check(name, ext_dir, manifest)

    version = manifest['version']
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    out = dist / f'{name}-{version}.zip'
    files = list(runtime_files(ext_dir))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for path, rel in files:
            z.write(path, f'{name}/{rel.as_posix()}')
    print(f'{out.relative_to(ROOT)}  {len(files)} ファイル  {out.stat().st_size:,} バイト')
    for _, rel in files:
        print(f'  {name}/{rel.as_posix()}')

    if publish:
        dest_dir = VELWORKS / 'chrome_ext' / name
        if not dest_dir.is_dir():
            fail(f'紹介ページのフォルダがない: {dest_dir}')
        for old in dest_dir.glob(f'{name}-*.zip'):
            old.unlink()
        dest = dest_dir / out.name
        dest.write_bytes(out.read_bytes())
        print(f'→ {dest}')
        print('次に: catalog.json の version と紹介ページ（ダウンロード・更新履歴）を直し、vel.works をビルドして chrome_ext と top を反映する')


if __name__ == '__main__':
    main()
