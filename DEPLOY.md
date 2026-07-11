# Deploy — что осталось сделать (только на твоей машине)

Я довёл проект до полностью готового к деплою состояния: код собран логически, program ID
синхронизирован (`BmDc7HBxBt5bZLFz6UJ24mdHYr7DQfFw7eSnpo3HamQ6`), клиент уже вшит на этот ID, а
одноразовый devnet-кошелёк **уже профинансирован (5 SOL)**.

**Почему деплой не сделан из облака:** песочница, где я работаю, держит GitHub за allowlist, поэтому
`anchor build` не может скачать `platform-tools` (BPF-компилятор) → бинарь программы там не собрать.
На твоём Mac этой проблемы нет.

## Быстрый путь (один скрипт)

Нужно: Rust, Solana CLI, Anchor 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`).

```bash
cd tap-duel-arena
./deploy.sh
```

Скрипт: соберёт программу, задеплоит на devnet с приложенного профинансированного кошелька,
сохранит program ID тем же (совпадает с клиентом), впишет свежий IDL в клиент и напечатает
explorer-ссылку.

Затем клиент:
```bash
cd app
cp .env.example .env.local     # уже VITE_MODE=onchain + нужный program ID
npm install && npm run dev
```

## Что в комплекте
- `deploy-keypair.json` — плательщик, адрес `D7a3wckgmJ43xnRo7aqSFF9MdapXoM5fWcCAqiYb96bv`, ~5 SOL
  devnet. Одноразовый, **только devnet, ценности не имеет** — можно смело использовать и потом выбросить.
- `program-keypair.json` — keypair программы, чтобы program ID остался `BmDc7…` и совпал с клиентом.
- Оба уже в `.gitignore` — **не коммить их в публичный GitHub-репо.**

## Проверка ER-флоу (по желанию)
После деплоя открой клиент в двух вкладках телефона/браузера: одна — «Host a Duel» (шарит duel-code),
вторая — «Join» по коду. Тапайте — транзакции идут на Ephemeral Rollup (gasless), по победе хост
автоматически коммитит финал на L1, и на экране победы будет ссылка на Solana Explorer.

Если `anchor build` заругается на аккаунты в `delegate_duel` — сверь их с官方 counter-примером
(`github.com/magicblock-labs/magicblock-engine-examples`); механика делегирования там 1-в-1.

## Финальные шаги сабмита (нужен твой логин)
1. **GitHub:** создай публичный репо и запушь (кроме `*-keypair.json`). Команды:
   ```bash
   cd tap-duel-arena && git init && git add -A && git commit -m "Tap-Duel Arena — Solana Blitz V6"
   gh repo create tap-duel-arena --public --source=. --push
   ```
2. **Demo-видео:** открой demo-режим (мгновенно играется), затем покажи реальный on-chain матч и
   explorer-ссылку. 60–90 сек достаточно.
3. **Сабмит:** через событие «Submission: Solana Blitz v6» в календаре MagicBlock на Luma.
