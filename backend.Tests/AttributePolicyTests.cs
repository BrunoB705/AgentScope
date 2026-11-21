public sealed class AttributePolicyTests
{
    [Theory]
    [InlineData("compassion")]
    [InlineData("monkey_count")]
    [InlineData("profile")]
    [InlineData("tokenizer_name")]
    [InlineData("keyboard_layout")]
    [InlineData("trace.id")]
    [InlineData("tool_name")]
    [InlineData("opencode_event")]
    public void KeysThatOnlyContainABlockedWordAsSubstringAreKept(string key)
    {
        Assert.False(AttributePolicy.IsBlockedKey(key));
    }

    [Theory]
    [InlineData("prompt")]
    [InlineData("api_key")]
    [InlineData("apiKey")]
    [InlineData("APIKey")]
    [InlineData("filePath")]
    [InlineData("file-name")]
    [InlineData("filename")]
    [InlineData("x.secret")]
    [InlineData("oauth2Token")]
    [InlineData("tool.output")]
    [InlineData("Authorization")]
    public void KeysWithABlockedTokenAreDropped(string key)
    {
        Assert.True(AttributePolicy.IsBlockedKey(key));
    }

    [Fact]
    public void TokenizeSplitsPunctuationCamelCaseAcronymsAndDigits()
    {
        Assert.Equal(new[] { "api", "key", "id" }, AttributePolicy.Tokenize("APIKey_id"));
        Assert.Equal(new[] { "oauth", "2", "token" }, AttributePolicy.Tokenize("oauth2Token"));
    }

    [Fact]
    public void TruncationIsFlaggedWithDroppedCount()
    {
        var input = Enumerable.Range(0, 40).ToDictionary(i => $"attr_{i:D2}", i => i.ToString());
        var result = AttributePolicy.Sanitize(input);
        Assert.Equal(AttributePolicy.MaxAttributes + 2, result.Count);
        Assert.Equal("true", result[AttributePolicy.TruncatedKey]);
        Assert.Equal("8", result[AttributePolicy.DroppedKey]);
        Assert.True(result.ContainsKey("attr_00"));
        Assert.False(result.ContainsKey("attr_39"));
    }

    [Fact]
    public void BlockedKeysDoNotConsumeTheAttributeBudget()
    {
        var input = new Dictionary<string, string> { ["prompt"] = "private", ["command"] = "private" };
        foreach (var i in Enumerable.Range(0, AttributePolicy.MaxAttributes)) input[$"attr_{i:D2}"] = "v";
        var result = AttributePolicy.Sanitize(input);
        Assert.Equal(AttributePolicy.MaxAttributes, result.Count);
        Assert.False(result.ContainsKey(AttributePolicy.TruncatedKey));
    }

    [Fact]
    public void ResanitizingStoredAttributesKeepsTheTruncationMarker()
    {
        var input = Enumerable.Range(0, 35).ToDictionary(i => $"attr_{i:D2}", i => "v");
        var stored = AttributePolicy.Sanitize(input);
        var again = AttributePolicy.Sanitize(stored);
        Assert.Equal(stored, again);
        Assert.Equal("3", again[AttributePolicy.DroppedKey]);
    }

    [Fact]
    public void WhitespaceKeysAreIgnoredAndValuesAreBounded()
    {
        var result = AttributePolicy.Sanitize(new Dictionary<string, string> { [" "] = "x", ["long"] = new string('a', 900) });
        Assert.Single(result);
        Assert.Equal(AttributePolicy.MaxValueLength, result["long"].Length);
    }
}
