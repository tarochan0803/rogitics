# Claude Sonnet Delegation For Index3D

本体アプリの改修で、Claude Code Sonnet に実装を委任し、監督側が成果物を確認するための運用。

## 対象

- 現行入口: `index3D_V2.0.html`
- 主実装: `src/index3dMain.js`
- 周辺: `src/ui/*`, `src/3d/*`, `src/core/*`, `src/sim/*`, `src/batch/*`

## 委任コマンド

```bash
scripts/claude_sonnet_index3d_task.sh "ここに実装してほしい内容を書く"
```

長い指示はファイルに書く。

```bash
scripts/claude_sonnet_index3d_task.sh --prompt-file runtime/task.txt
```

Claude の出力は以下に残る。

```text
runtime/claude_delegate/<UTC時刻>/prompt.txt
runtime/claude_delegate/<UTC時刻>/claude_output.txt
```

## 監督側の確認

Claude が実装した後、監督側は必ず確認する。

1. 変更ファイル確認
   - 対象外ファイルを触っていないか
   - `road_seg/dataset`, `runtime/worlds`, モデル重みなどを壊していないか
2. 静的確認
   - 変更JSに `node --check`
   - Python変更なら `py_compile`
3. 起動確認
   - `scripts/start_local.sh` または既存起動手順
   - `index3D_V2.0.html` をブラウザで開く
4. ブラウザ確認
   - console error
   - 3D canvas 非blank
   - 経路作成
   - 自動走行
   - 変更した機能
5. 変更内容の採否
   - 仕様に合うなら採用
   - 余計な変更があれば手で戻すか、Claude に修正を再委任

## 分担の原則

- 複数Claudeに同じファイルを同時編集させない。
- UI担当、3D担当、road_seg担当、レビュー担当に分ける。
- 統合は1人が行う。
- Claude の実装結果は信用せず、必ず監督側が検証する。
