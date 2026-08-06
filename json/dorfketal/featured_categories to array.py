import json

# 1. 讀取 JSON 檔案
file_path = "products.json"

with open(file_path, "r", encoding="utf-8") as f:
    data = json.load(f)  # 使用 load 代替 loads

merged_data = {}

for item in data:
    name = item["product_name"]
    category = item.get("featured_categories")

    # 確保分類轉換為清單/陣列
    cat_list = [category] if isinstance(category, str) and category else (category or [])

    if name not in merged_data:
        # 第一次遇到該產品，初始化 featured_categories 為 list
        item["featured_categories"] = cat_list
        merged_data[name] = item
    else:
        # 已存在該產品，將新的分類追加進去（並去重）
        existing_cats = set(merged_data[name]["featured_categories"])
        existing_cats.update(cat_list)
        merged_data[name]["featured_categories"] = list(existing_cats)

# 轉回 JSON 格式陣列
result = list(merged_data.values())
output_json = json.dumps(result, ensure_ascii=False, indent=2)

print(output_json)

# （可選）如果你想把合併後的結果直接存成新檔案：
with open("products.json", "w", encoding="utf-8") as f:
    f.write(output_json)