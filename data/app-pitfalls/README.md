アプリ実装側の落とし穴。スキーマは `../pitfalls/_schema.json` と共通です。

ここの `status` は、このリポジトリではなく、**その穴を踏んだ事例のプロジェクト**の状態です。
読み方と、開いている穴をまだ入れていない理由は
[docs/08 の「アプリ側のレコード」](../../docs/08-pitfall-records.md#アプリ側のレコード) にあります。

1 件足すときは `../pitfalls/_template.json` をここへ `<id>.json` としてコピーし、`layer` を `app` にします。
