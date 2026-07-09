# Training Dataset Prep

This folder contains a utility to turn `annotated_result.jsonl` from the
annotation tool into training datasets for VLM-style fine-tuning.

## Requirements
- Node.js (no extra dependencies)

## Usage
```
node prepare_dataset.js --input "C:\path\to\annotated_result.jsonl"
```

Optional flags:
- `--out <dir>` Output directory (default: `dataset_YYYYMMDDHHMMSS` in the input folder)
- `--images-dir <dir>` Folder that contains the images (default: input file directory)
- `--split <ratio>` Train split ratio (default: `0.9`)
- `--seed <n>` Shuffle seed (default: `42`)
- `--no-copy-images` Do not copy images; JSONL will reference absolute image paths

## Output
The tool creates an output folder with:
- `images/` (if copy enabled)
- `train_vehicle_qa.jsonl`
- `val_vehicle_qa.jsonl`
- `train_max_ok.jsonl`
- `val_max_ok.jsonl`
- `dataset_stats.json`

### Dataset format
`train_vehicle_qa.jsonl` and `val_vehicle_qa.jsonl` contain one record per
image per vehicle type:
```
{"image":"images/task_001.jpg","prompt":"Is a 2t truck allowed to pass on this road? Answer OK or NG.","response":"OK","meta":{"task_id":1,"vehicle":"2t_flat","address":"...","comment":"..."}}
```

`train_max_ok.jsonl` and `val_max_ok.jsonl` contain one record per image:
```
{"image":"images/task_001.jpg","prompt":"What is the largest truck size allowed on this road? Choose one of 2t, 3t, 4t, 10t, NG.","response":"4t","meta":{"task_id":1,"address":"...","comment":"...","inconsistent":false}}
```

## Notes
- The script skips entries with `errorMessage`, missing images, or incomplete annotations.
- If you want Japanese prompts, edit `VEHICLE_PROMPT_TEMPLATE` and `MAX_OK_PROMPT`
  in `prepare_dataset.js`.
