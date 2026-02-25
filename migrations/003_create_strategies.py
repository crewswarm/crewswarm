def up():
    with open("strategies.sql", "r") as f:
        db.session.execute(f.read())

    db.session.commit()

    print("Created strategies table")
