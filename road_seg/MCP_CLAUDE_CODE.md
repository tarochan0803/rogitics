# Claude Code MCP

このリポジトリでは Claude Code から `road_seg` の定型作業を呼べるように、
project scope の MCP サーバ `logistics-road-seg` を設定している。

## 設定ファイル

- `.mcp.json`
- `scripts/road_seg_mcp.sh`
- `road_seg/mcp_server.py`
- `.mcp-venv/` はローカル生成物

Claude Code でこのプロジェクトを開くと、`logistics-road-seg` が自動接続される。

確認:

```bash
claude mcp list
claude mcp get logistics-road-seg
```

## 使える MCP tools

- `road_seg_dataset_stats`: 手動ラベル数、弱教師数、現行モデルmetaを確認
- `road_seg_selfcheck`: ネット不要の幾何自己診断
- `road_seg_smoke`: API/annotate の in-process smoke
- `road_seg_compare_models`: site0008/site0019 などで U-Net / DeepLabV3+ 比較
- `road_seg_train_mixed`: 手動ラベル + 弱教師で学習
- `road_seg_start_label_server`: `/annotate/ui` サーバ起動
- `road_seg_stop_label_server`: 起動したサーバ停止
- `road_seg_import_label_dataset_zip`: 協力者から返ってきた dataset ZIP を安全に統合
- `road_seg_make_labeling_handoff`: 協力者向けラベル作成ZIPを生成

## 実行環境

MCP SDK は `.mcp-venv` に分離している。実際の `road_seg` 処理は
`ROAD_SEG_PYTHON` で指定した Python に投げる。

現在の `.mcp.json` では:

```text
ROAD_SEG_PYTHON=/home/ncnadmin/.pyenv/versions/fa-env/bin/python
```

別環境に移す場合は `.mcp.json` の `ROAD_SEG_PYTHON` を、その環境で
`road_seg` が動く Python に変更する。
