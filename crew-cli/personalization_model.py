```python
# Import necessary libraries
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score

# Load user interaction data
user_interaction_data = pd.read_csv('user_interaction_data.csv')

# Preprocess data
X = user_interaction_data.drop(['user_id', 'interaction'], axis=1)
y = user_interaction_data['interaction']

# Split data into training and testing sets
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Train a random forest classifier
model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

# Make predictions on the test set
y_pred = model.predict(X_test)

# Evaluate the model
accuracy = accuracy_score(y_test, y_pred)
print(f'Model accuracy: {accuracy:.3f}')

# Save the trained model
import pickle
with open('personalization_model.pkl', 'wb') as f:
    pickle.dump(model, f)
```
