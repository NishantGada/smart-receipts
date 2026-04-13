import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useRef, useEffect, useState } from 'react';
import { Image, Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

export default function App() {
  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [extractedData, setExtractedData] = useState(null);

  const [splitInstructions, setSplitInstructions] = useState('');
  const [splitResults, setSplitResults] = useState(null);

  const scrollViewRef = useRef(null);
  const textInputRef = useRef(null);

  const processReceipt = async () => {
    setLoading(true);

    try {
      const apiKey = process.env.EXPO_PUBLIC_GOOGLE_API_KEY;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `You are an expert receipt parser. Extract ALL information from this receipt.
  
  Requirements:
  1. List EVERY item with its exact price
  2. Extract subtotal, tax, tip (if any), and total
  3. Validate: subtotal + tax + tip should equal total
  4. If validation fails, flag it
  
  Return ONLY valid JSON (no markdown, no code blocks, no explanation):
  {
    "items": [{"name": "string", "price": number}],
    "subtotal": number,
    "tax": number,
    "tip": number,
    "total": number,
    "validation": {"matches": boolean, "discrepancy": number},
    "currency": "USD"
  }`
              },
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: image.base64
                }
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1000,
          }
        }),
      });

      const data = await response.json();
      console.log('Gemini Response:', data);

      if (data.candidates && data.candidates[0]) {
        const content = data.candidates[0].content.parts[0].text;
        console.log('Raw content:', content);

        // Clean up potential markdown formatting
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanContent);

        setExtractedData(parsed);
        console.log('Extracted data:', parsed);
      }
    } catch (error) {
      console.error('Error:', error);

      if (error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
        alert('Rate limit reached! Please wait a minute and try again. Free tier resets daily.');
      } else {
        alert('Error processing. Check console for details.');
      }
    } finally {
      setLoading(false);
    }
  };

  const processSplit = async () => {
    setLoading(true);

    try {
      const apiKey = process.env.EXPO_PUBLIC_GOOGLE_API_KEY;

      // Create a context for the LLM
      const itemsList = extractedData.items.map(item => `${item.name}: $${item.price}`).join('\n');

      const prompt = `You are a bill splitting calculator. Parse the instructions and calculate amounts.
  
  RECEIPT ITEMS:
  ${itemsList}
  
  SPLIT INSTRUCTIONS:
  "${splitInstructions}"
  
  RULES:
  - Match item names flexibly (ignore exact case/spacing)
  - If an item isn't mentioned, note it as "unassigned"
  - Calculate exact dollar amounts per person
  - Be concise
  
  Return ONLY this JSON (no explanation, no markdown):
  {
    "splits": [
      {"person": "name", "items": ["item1"], "amount": 0.00}
    ],
    "total": 0.00,
    "validation": {"allItemsAssigned": true, "message": ""}
  }`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2000,
            responseLogprobs: false,
            stopSequences: []
          }
        }),
      });

      const data = await response.json();
      console.log('Split Response:', data);

      if (data.candidates && data.candidates[0]) {
        const content = data.candidates[0].content.parts[0].text;
        console.log('Raw split content:', content);

        // More aggressive cleaning
        let cleanContent = content
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .replace(/^[^{]*/g, '')  // Remove everything before first {
          .replace(/[^}]*$/g, '')  // Remove everything after last }
          .trim();

        console.log('Cleaned content:', cleanContent);
        const parsed = JSON.parse(cleanContent);

        setSplitResults(parsed);
        console.log('Split results:', parsed);
      }
    } catch (error) {
      console.error('Error:', error);

      if (error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
        alert('Rate limit reached! Please wait a minute and try again. Free tier resets daily.');
      } else {
        alert('Error processing. Check console for details.');
      }
    } finally {
      setLoading(false);
    }
  };

  const pickImage = async () => {
    // Request permission
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (permissionResult.granted === false) {
      alert('Permission to access gallery is required!');
      return;
    }

    // Launch image picker
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 1,
      base64: true, // We need base64 for OpenAI
    });

    if (!result.canceled) {
      setImage(result.assets[0]);
      console.log('Image selected:', result.assets[0].uri);
    }
  };

  const dismissKeyboard = () => {
    Keyboard.dismiss();
  };

  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener(
      'keyboardDidShow',
      () => {
        // Scroll to bottom when keyboard opens
        setTimeout(() => {
          scrollViewRef.current?.scrollToEnd({ animated: true });
        }, 100);
      }
    );

    return () => {
      keyboardDidShowListener.remove();
    };
  }, []);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={dismissKeyboard}
      >

        <View style={!image && !extractedData ? styles.centerContent : null}>
          <Text style={styles.title}>Smart Receipt Splitter</Text>
          <TouchableOpacity style={styles.button} onPress={pickImage}>
            <Text style={styles.buttonText}>Upload Receipt</Text>
          </TouchableOpacity>
        </View>

        {image && (
          <View style={styles.imageContainer}>
            <Image source={{ uri: image.uri }} style={styles.image} />
            <Text style={styles.imageText}>Receipt loaded! ✅</Text>
          </View>
        )}

        {image && !loading && (
          <TouchableOpacity
            style={[styles.button, { marginTop: 20, backgroundColor: '#34C759' }]}
            onPress={processReceipt}
          >
            <Text style={styles.buttonText}>Process Receipt</Text>
          </TouchableOpacity>
        )}

        {loading && (
          <Text style={styles.loadingText}>Processing receipt... 🔄</Text>
        )}

        {extractedData && !loading && (
          <View style={styles.extractedContainer}>
            <Text style={styles.sectionTitle}>Receipt Details</Text>

            <View style={styles.itemsList}>
              {extractedData.items.map((item, index) => (
                <View key={index} style={styles.itemRow}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemPrice}>${item.price.toFixed(2)}</Text>
                </View>
              ))}
            </View>

            <View style={styles.totalsContainer}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal:</Text>
                <Text style={styles.totalValue}>${extractedData.subtotal.toFixed(2)}</Text>
              </View>
              {extractedData.tax > 0 && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax:</Text>
                  <Text style={styles.totalValue}>${extractedData.tax.toFixed(2)}</Text>
                </View>
              )}
              {extractedData.tip > 0 && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tip:</Text>
                  <Text style={styles.totalValue}>${extractedData.tip.toFixed(2)}</Text>
                </View>
              )}
              <View style={[styles.totalRow, styles.finalTotal]}>
                <Text style={styles.totalLabelBold}>Total:</Text>
                <Text style={styles.totalValueBold}>${extractedData.total.toFixed(2)}</Text>
              </View>
            </View>

            {extractedData.validation.matches ? (
              <Text style={styles.validationSuccess}>✅ Math checks out!</Text>
            ) : (
              <Text style={styles.validationError}>
                ⚠️ Discrepancy: ${Math.abs(extractedData.validation.discrepancy).toFixed(2)}
              </Text>
            )}
          </View>
        )}

        {extractedData && !splitResults && (
          <View style={styles.splitInputContainer}>
            <Text style={styles.sectionTitle}>How to Split?</Text>
            <Text style={styles.instructionText}>
              Example: "bananas on Alex, rolls and bread on Beth, sauce split between Alex and Beth"
            </Text>

            <TextInput
              ref={textInputRef}
              style={styles.textInput}
              multiline
              numberOfLines={4}
              placeholder="Enter split instructions..."
              value={splitInstructions}
              onChangeText={setSplitInstructions}
              onFocus={() => {
                setTimeout(() => {
                  scrollViewRef.current?.scrollToEnd({ animated: true });
                }, 300);
              }}
            />

            <TouchableOpacity
              style={[styles.button, { backgroundColor: '#FF9500' }]}
              onPress={processSplit}
              disabled={!splitInstructions.trim()}
            >
              <Text style={styles.buttonText}>Split Bill</Text>
            </TouchableOpacity>
          </View>
        )}

        {splitResults && (
          <View style={styles.resultsContainer}>
            <Text style={styles.sectionTitle}>Split Results</Text>

            {splitResults.splits.map((split, index) => (
              <View key={index} style={styles.personCard}>
                <Text style={styles.personName}>{split.person}</Text>
                <Text style={styles.personAmount}>${split.amount.toFixed(2)}</Text>
                {split.items.length > 0 && (
                  <Text style={styles.personItems}>
                    Items: {split.items.join(', ')}
                  </Text>
                )}
              </View>
            ))}

            <View style={styles.finalTotalResult}>
              <Text style={styles.totalLabelBold}>Total:</Text>
              <Text style={styles.totalValueBold}>${splitResults.total.toFixed(2)}</Text>
            </View>

            <TouchableOpacity
              style={[styles.button, { marginTop: 20, backgroundColor: '#666' }]}
              onPress={() => {
                setSplitResults(null);
                setSplitInstructions('');
              }}
            >
              <Text style={styles.buttonText}>Split Again</Text>
            </TouchableOpacity>
          </View>
        )}

        <StatusBar style="auto" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 10,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },

  // Image styles
  imageContainer: {
    marginTop: 20,
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 20,
  },
  image: {
    width: '100%',
    height: 300,
    resizeMode: 'contain',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  imageText: {
    marginTop: 10,
    fontSize: 16,
    color: '#007AFF',
  },

  loadingText: {
    marginTop: 20,
    fontSize: 16,
    color: '#666',
    fontStyle: 'italic',
  },

  // extracted information styles
  extractedContainer: {
    marginTop: 20,
    width: '100%',
    backgroundColor: '#f8f8f8',
    borderRadius: 10,
    padding: 15,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 15,
    textAlign: 'center',
  },
  itemsList: {
    marginBottom: 15,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  itemName: {
    fontSize: 14,
    flex: 1,
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: '600',
  },
  totalsContainer: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: '#ccc',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  totalLabel: {
    fontSize: 14,
    color: '#666',
  },
  totalValue: {
    fontSize: 14,
    color: '#666',
  },
  totalLabelBold: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  totalValueBold: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  finalTotal: {
    marginTop: 5,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: '#000',
  },
  validationSuccess: {
    marginTop: 15,
    textAlign: 'center',
    color: '#34C759',
    fontSize: 16,
    fontWeight: '600',
  },
  validationError: {
    marginTop: 15,
    textAlign: 'center',
    color: '#FF3B30',
    fontSize: 16,
    fontWeight: '600',
  },

  // text input styles
  splitInputContainer: {
    marginTop: 20,
    width: '100%',
  },
  instructionText: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
    marginBottom: 10,
    textAlign: 'center',
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    backgroundColor: '#fff',
    marginBottom: 15,
  },

  // result styles
  resultsContainer: {
    marginTop: 20,
    width: '100%',
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    padding: 15,
  },
  personCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  personName: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 5,
  },
  personAmount: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#007AFF',
    marginBottom: 5,
  },
  personItems: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
  },
  finalTotalResult: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 15,
    paddingTop: 15,
    borderTopWidth: 2,
    borderTopColor: '#007AFF',
  },
});