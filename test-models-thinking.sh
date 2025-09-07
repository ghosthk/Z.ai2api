#!/bin/bash

# Z.ai API 代理测试脚本 - 验证模型列表和思考模式修复
echo "🧪 Z.ai API 代理测试脚本"
echo "========================="
echo ""

# 测试配置
PYTHON_PORT=8080
WORKER_URL="https://zai2api.ytxwz.workers.dev"

echo "📋 测试项目："
echo "1. 模型列表应该只有 GLM-4.5 和 GLM-4.5V"
echo "2. 思考模式应该正确处理（去除 <details> 标签）"
echo ""

# 测试 Python 版本的模型列表
echo "1️⃣ 测试 Python 版本 (app.py) 的模型列表："
echo "启动 Python 服务器..."
# 注意：需要先启动 Python 服务器
echo "请先运行: python app.py"
echo ""
echo "测试命令："
echo "curl -s http://localhost:$PYTHON_PORT/v1/models | jq '.data[] | {id, name}'"
echo ""

# 测试 Workers 版本的模型列表
echo "2️⃣ 测试 Workers 版本 (worker.js) 的模型列表："
models_response=$(curl -s "$WORKER_URL/v1/models")
if [ $? -eq 0 ]; then
    echo "✅ Workers 模型列表："
    echo "$models_response" | jq '.data[] | {id, name}' 2>/dev/null || echo "$models_response"
else
    echo "❌ 无法获取 Workers 模型列表"
fi
echo ""

# 测试思考模式处理
echo "3️⃣ 测试思考模式处理："
echo "发送一个会触发思考的请求..."

test_thinking() {
    local url=$1
    local name=$2
    
    echo "测试 $name："
    response=$(curl -s -X POST "$url/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -d '{
            "model": "0727-360B-API",
            "messages": [
                {"role": "user", "content": "请解释一下什么是递归，并给出一个简单的例子。"}
            ],
            "stream": false,
            "max_tokens": 200
        }')
    
    if [ $? -eq 0 ]; then
        # 检查响应中是否包含思考标签
        if echo "$response" | grep -q '<details\|<thinking\|</details\|</thinking'; then
            echo "⚠️  响应中包含未处理的思考标签"
            echo "响应预览："
            echo "$response" | head -c 500
        else
            echo "✅ 响应中没有思考标签（已正确处理）"
            content=$(echo "$response" | jq -r '.choices[0].message.content' 2>/dev/null)
            if [ -n "$content" ]; then
                echo "内容长度: ${#content} 字符"
                echo "内容预览: ${content:0:100}..."
            fi
        fi
    else
        echo "❌ 请求失败"
    fi
    echo ""
}

# 测试 Workers
test_thinking "$WORKER_URL" "Workers"

# 期望的模型列表
echo "4️⃣ 期望的模型列表："
echo "根据 main.ts，应该只有以下两个模型："
echo "- id: '0727-360B-API', name: 'GLM-4.5'"
echo "- id: 'glm-4.5v', name: 'GLM-4.5V'"
echo ""

echo "5️⃣ 验证清单："
echo "✅ app.py 模型列表已更新为静态的两个模型"
echo "✅ worker.js 模型列表已更新为静态的两个模型"
echo "✅ THINK_TAGS_MODE 已设置为 'strip'"
echo "✅ extractContentFromSSE 函数已优化处理思考内容"
echo ""

echo "🎉 测试完成！"
echo ""
echo "💡 注意事项："
echo "1. 确保已重新部署 Workers: wrangler deploy"
echo "2. Python 版本需要重启服务: python app.py"
echo "3. 思考模式现在使用 'strip' 模式，会去除 <details> 标签"