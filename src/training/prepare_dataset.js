#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PRESETS = ['2t_flat', '3t_flat', '4t_flat', '10t_unic'];
const PRESET_LABELS = {
  '2t_flat': '2t truck',
  '3t_flat': '3t truck',
  '4t_flat': '4t truck',
  '10t_unic': '10t truck (unic)'
};

const DEFAULT_SPLIT = 0.9;
const DEFAULT_SEED = 42;

const VEHICLE_PROMPT_TEMPLATE = 'Is a {vehicle} allowed to pass on this road? Answer OK or NG.';
const MAX_OK_PROMPT = 'What is the largest truck size allowed on this road? Choose one of 2t, 3t, 4t, 10t, NG.';

function usage() {
  const text = [
    'Usage:',
    '  node prepare_dataset.js --input <annotated_result.jsonl> [--out <dir>]',
    'Options:',
    '  --input, -i       Path to annotated_result.jsonl (required)',
    '  --out, -o         Output directory (default: dataset_YYYYMMDDHHMMSS in input folder)',
    '  --images-dir      Directory that contains the images (default: input file directory)',
    '  --split           Train split ratio (default: 0.9)',
    '  --seed            Shuffle seed (default: 42)',
    '  --no-copy-images  Do not copy images; use absolute image paths in JSONL',
    '  --help, -h        Show this help'
  ].join('\n');
  console.log(text);
}

function parseArgs(argv) {
  const args = { copyImages: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') args.input = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--images-dir') args.imagesDir = argv[++i];
    else if (a === '--split') args.split = parseFloat(argv[++i]);
    else if (a === '--seed') args.seed = parseInt(argv[++i], 10);
    else if (a === '--no-copy-images') args.copyImages = false;
    else if (a === '--copy-images') args.copyImages = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      args.unknown = args.unknown || [];
      args.unknown.push(a);
    }
  }
  return args;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function computeMaxOk(annotations) {
  let maxPreset = null;
  for (const p of PRESETS) {
    if (annotations[p] === 'OK') maxPreset = p;
  }
  const label = maxPreset ? maxPreset.split('_')[0] : 'NG';

  let seenNG = false;
  let inconsistent = false;
  for (const p of PRESETS) {
    const v = annotations[p];
    if (v === 'NG') seenNG = true;
    if (v === 'OK' && seenNG) inconsistent = true;
  }
  return { label, inconsistent };
}

function writeJsonl(filePath, rows) {
  const text = rows.map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, rows.length ? text + '\n' : '', 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.unknown) {
    if (args.unknown) console.error('Unknown args: ' + args.unknown.join(' '));
    usage();
    process.exit(args.unknown ? 1 : 0);
  }
  if (!args.input) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error('Input file not found: ' + inputPath);
    process.exit(1);
  }

  const baseDir = path.dirname(inputPath);
  const imagesDir = path.resolve(args.imagesDir || baseDir);
  const split = Number.isFinite(args.split) ? args.split : DEFAULT_SPLIT;
  const seed = Number.isFinite(args.seed) ? args.seed : DEFAULT_SEED;
  const copyImages = args.copyImages !== false;

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.resolve(args.out || path.join(baseDir, `dataset_${ts}`));
  const imageOutDir = path.join(outDir, 'images');
  ensureDir(outDir);
  if (copyImages) ensureDir(imageOutDir);

  const raw = fs.readFileSync(inputPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  const byImage = new Map();
  const stats = {
    input: inputPath,
    imagesDir,
    outDir,
    totalLines: lines.length,
    usedImages: 0,
    skipped: {
      parseError: 0,
      errorMessage: 0,
      missingImageFile: 0,
      missingAnnotations: 0,
      incompleteAnnotations: 0,
      missingImageOnDisk: 0,
      duplicateImage: 0
    }
  };

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      stats.skipped.parseError++;
      continue;
    }

    if (obj.errorMessage || obj.status === 'ERROR') {
      stats.skipped.errorMessage++;
      continue;
    }

    if (!obj.imageFile) {
      stats.skipped.missingImageFile++;
      continue;
    }

    if (!obj.annotations) {
      stats.skipped.missingAnnotations++;
      continue;
    }

    const missing = PRESETS.filter(p => obj.annotations[p] == null);
    if (missing.length > 0) {
      stats.skipped.incompleteAnnotations++;
      continue;
    }

    const srcImagePath = path.resolve(imagesDir, obj.imageFile);
    if (!fs.existsSync(srcImagePath)) {
      stats.skipped.missingImageOnDisk++;
      continue;
    }

    const imageFileName = path.basename(obj.imageFile);
    const imageRel = `images/${imageFileName}`;
    const imageKey = copyImages ? imageRel : srcImagePath;
    if (byImage.has(imageKey)) {
      stats.skipped.duplicateImage++;
      continue;
    }

    if (copyImages) {
      const dst = path.join(imageOutDir, imageFileName);
      if (!fs.existsSync(dst)) fs.copyFileSync(srcImagePath, dst);
    }

    const address = (obj.input && obj.input.address) ? String(obj.input.address) : '';
    const comment = (obj.input && obj.input.comment) ? String(obj.input.comment) : '';

    const imageRef = copyImages ? imageRel : srcImagePath.replace(/\\/g, '/');

    const vehicleRecords = PRESETS.map(p => ({
      image: imageRef,
      prompt: VEHICLE_PROMPT_TEMPLATE.replace('{vehicle}', PRESET_LABELS[p]),
      response: obj.annotations[p],
      meta: {
        task_id: obj.task_id,
        vehicle: p,
        address,
        comment
      }
    }));

    const maxInfo = computeMaxOk(obj.annotations);
    const maxOkRecord = {
      image: imageRef,
      prompt: MAX_OK_PROMPT,
      response: maxInfo.label,
      meta: {
        task_id: obj.task_id,
        address,
        comment,
        inconsistent: maxInfo.inconsistent
      }
    };

    byImage.set(imageKey, { vehicleRecords, maxOkRecord });
  }

  const imageKeys = Array.from(byImage.keys());
  const rand = mulberry32(seed);
  shuffle(imageKeys, rand);

  let trainCount = Math.floor(imageKeys.length * Math.min(Math.max(split, 0), 1));
  if (imageKeys.length <= 1) trainCount = imageKeys.length;
  if (trainCount === 0 && imageKeys.length > 0) trainCount = 1;

  const trainSet = new Set(imageKeys.slice(0, trainCount));
  const trainVehicle = [];
  const valVehicle = [];
  const trainMaxOk = [];
  const valMaxOk = [];

  const labelStats = {
    vehicle: { OK: 0, NG: 0 },
    maxOk: { '2t': 0, '3t': 0, '4t': 0, '10t': 0, NG: 0 },
    inconsistent: 0
  };

  for (const [key, data] of byImage.entries()) {
    const bucket = trainSet.has(key) ? 'train' : 'val';
    for (const rec of data.vehicleRecords) {
      if (bucket === 'train') trainVehicle.push(rec);
      else valVehicle.push(rec);
      if (rec.response === 'OK') labelStats.vehicle.OK++;
      else if (rec.response === 'NG') labelStats.vehicle.NG++;
    }
    if (bucket === 'train') trainMaxOk.push(data.maxOkRecord);
    else valMaxOk.push(data.maxOkRecord);
    if (labelStats.maxOk[data.maxOkRecord.response] != null) {
      labelStats.maxOk[data.maxOkRecord.response]++;
    }
    if (data.maxOkRecord.meta.inconsistent) labelStats.inconsistent++;
  }

  stats.usedImages = imageKeys.length;
  stats.split = { trainImages: trainSet.size, valImages: imageKeys.length - trainSet.size };
  stats.records = {
    trainVehicle: trainVehicle.length,
    valVehicle: valVehicle.length,
    trainMaxOk: trainMaxOk.length,
    valMaxOk: valMaxOk.length
  };
  stats.labels = labelStats;
  stats.copyImages = copyImages;

  writeJsonl(path.join(outDir, 'train_vehicle_qa.jsonl'), trainVehicle);
  writeJsonl(path.join(outDir, 'val_vehicle_qa.jsonl'), valVehicle);
  writeJsonl(path.join(outDir, 'train_max_ok.jsonl'), trainMaxOk);
  writeJsonl(path.join(outDir, 'val_max_ok.jsonl'), valMaxOk);
  fs.writeFileSync(path.join(outDir, 'dataset_stats.json'), JSON.stringify(stats, null, 2), 'utf8');

  console.log('Dataset prepared: ' + outDir);
  console.log('Images used: ' + stats.usedImages);
  console.log('Train images: ' + stats.split.trainImages + ', Val images: ' + stats.split.valImages);
  console.log('Train vehicle QA: ' + trainVehicle.length + ', Val vehicle QA: ' + valVehicle.length);
  console.log('Train max OK: ' + trainMaxOk.length + ', Val max OK: ' + valMaxOk.length);
}

main();
